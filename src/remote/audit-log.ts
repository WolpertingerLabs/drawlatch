/**
 * `ingest_logs` — an append-only audit log that callers ship records into.
 *
 * The input mirrors OTLP's `ExportLogsServiceRequest` (JSON encoding) and the
 * response mirrors `ExportLogsServiceResponse`, but it rides the encrypted,
 * caller-authenticated drawlatch protocol rather than an OTLP endpoint.
 *
 * Each accepted record becomes one flattened JSON line in
 * `<config dir>/audit/<caller>/<YYYY-MM-DD>.jsonl` (UTC day of receipt).
 * Files are 0600 and directories 0700. drawlatch stamps every line with the
 * authenticated caller, the receive time, and a per-file sequence number; the
 * payload cannot set or override them.
 *
 * Validation is per record: a malformed record is rejected and counted in
 * `partialSuccess`, and the rest of the batch is still stored. Oversized
 * values are truncated (and the line marked `truncated: true`) rather than
 * rejected, because an audit record with a clipped field beats no record.
 *
 * There is deliberately no read, list, update, or delete path here. Callers
 * can append, nothing else; reading happens on the hub box.
 */

import fs from 'node:fs';
import path from 'node:path';

import { getConfigDir } from '../shared/config.js';
import { CALLER_ALIAS_REGEX } from './caller-bootstrap.js';

// ── Limits ─────────────────────────────────────────────────────────────────

/** Records past this count in one call are rejected. */
export const MAX_RECORDS_PER_CALL = 1000;
/** Stored bytes per call. Records that would push past it are rejected. */
export const MAX_BYTES_PER_CALL = 4 * 1024 * 1024;
/** One stored line, after truncation. Larger records are rejected. */
export const MAX_RECORD_BYTES = 256 * 1024;
/** Per caller per UTC day. Bounds how much disk one caller can fill. */
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
/** String values longer than this are cut and suffixed with TRUNCATION_MARKER. */
export const MAX_STRING_CHARS = 16 * 1024;
/** Attributes per list (record, resource, scope, kvlist): extras are dropped. */
export const MAX_ATTRIBUTES = 128;
/** Entries per arrayValue: extras are dropped. */
export const MAX_ARRAY_ITEMS = 256;
/** AnyValue nesting depth; anything deeper is replaced with TRUNCATION_MARKER. */
export const MAX_VALUE_DEPTH = 8;
export const MAX_KEY_CHARS = 256;
export const MAX_SHORT_STRING_CHARS = 256;
export const MAX_CALLER_ALIAS_CHARS = 128;
export const TRUNCATION_MARKER = '…[truncated]';
/** errorMessage keeps this many distinct reasons, each cut to MAX_REASON_CHARS. */
export const MAX_ERROR_REASONS = 10;
export const MAX_REASON_CHARS = 200;

// ── Wire types ─────────────────────────────────────────────────────────────

export interface IngestLogsResponse {
  partialSuccess?: { rejectedLogRecords: number; errorMessage: string };
}

/** The flattened shape of one stored line. */
export interface AuditLine {
  'drawlatch.caller': string;
  'drawlatch.received_at': string;
  'drawlatch.sequence': number;
  time_unix_nano?: string;
  observed_time_unix_nano?: string;
  severity_number?: number;
  severity_text?: string;
  event_name?: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  flags?: number;
  body?: unknown;
  attributes: Record<string, unknown>;
  dropped_attributes_count?: number;
  resource: Record<string, unknown>;
  resource_schema_url?: string;
  scope: { name?: string; version?: string; attributes?: Record<string, unknown> };
  scope_schema_url?: string;
  truncated?: true;
}

// ── Validation ─────────────────────────────────────────────────────────────

class RecordError extends Error {}

type Plain = Record<string, unknown>;

/** Tracks whether anything in the current record was cut. */
interface Clip {
  truncated: boolean;
}

function isObject(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkKeys(obj: Plain, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new RecordError(`${what}: unknown field "${key}"`);
  }
}

function truncateString(s: string, clip: Clip): string {
  if (s.length <= MAX_STRING_CHARS) return s;
  clip.truncated = true;
  let end = MAX_STRING_CHARS;
  // Don't split a surrogate pair.
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return s.slice(0, end) + TRUNCATION_MARKER;
}

function shortString(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new RecordError(`${what} must be a string`);
  if (v.length > MAX_SHORT_STRING_CHARS) {
    throw new RecordError(`${what} exceeds ${MAX_SHORT_STRING_CHARS} chars`);
  }
  return v;
}

/** uint64 in OTLP/JSON: a decimal string, or a non-negative safe integer. */
function uint64(v: unknown, what: string): string {
  if (typeof v === 'string' && /^\d{1,20}$/.test(v) && BigInt(v) <= 0xffffffffffffffffn) {
    return BigInt(v).toString();
  }
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  throw new RecordError(`${what} must be a uint64 (decimal string or non-negative integer)`);
}

function uint32(v: unknown, what: string): number {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff) return v;
  throw new RecordError(`${what} must be a uint32`);
}

/** int64 in OTLP/JSON. Stored as a number when it fits exactly, else a string. */
function int64(v: unknown, what: string): number | string {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d{1,19}$/.test(v)) {
    const n = BigInt(v);
    if (n >= -(2n ** 63n) && n < 2n ** 63n) {
      return Number.isSafeInteger(Number(n)) ? Number(n) : n.toString();
    }
  }
  throw new RecordError(`${what} must be an int64 (integer or decimal string)`);
}

function hexId(v: unknown, length: number, what: string): string | undefined {
  // OTLP/JSON allows an empty id to mean "unset".
  if (v === '') return undefined;
  if (typeof v === 'string' && v.length === length && /^[0-9a-fA-F]+$/.test(v)) {
    return v.toLowerCase();
  }
  throw new RecordError(`${what} must be ${length} hex chars`);
}

const ANY_VALUE_KEYS = [
  'stringValue',
  'boolValue',
  'intValue',
  'doubleValue',
  'bytesValue',
  'arrayValue',
  'kvlistValue',
] as const;

/** Convert an OTLP AnyValue to a plain JSON value, validating as we go. */
function anyValue(v: unknown, depth: number, clip: Clip, what: string): unknown {
  if (!isObject(v)) throw new RecordError(`${what} must be an AnyValue object`);
  const keys = Object.keys(v);
  // OTLP allows an empty AnyValue; it means "no value".
  if (keys.length === 0) return null;
  if (keys.length !== 1 || !(ANY_VALUE_KEYS as readonly string[]).includes(keys[0])) {
    throw new RecordError(`${what} must have exactly one of ${ANY_VALUE_KEYS.join(', ')}`);
  }
  const kind = keys[0] as (typeof ANY_VALUE_KEYS)[number];
  const inner = v[kind];
  switch (kind) {
    case 'stringValue':
      if (typeof inner !== 'string') throw new RecordError(`${what}.stringValue must be a string`);
      return truncateString(inner, clip);
    case 'boolValue':
      if (typeof inner !== 'boolean') throw new RecordError(`${what}.boolValue must be a boolean`);
      return inner;
    case 'intValue':
      return int64(inner, `${what}.intValue`);
    case 'doubleValue':
      if (typeof inner !== 'number' || !Number.isFinite(inner)) {
        throw new RecordError(`${what}.doubleValue must be a finite number`);
      }
      return inner;
    case 'bytesValue':
      if (typeof inner !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(inner)) {
        throw new RecordError(`${what}.bytesValue must be base64`);
      }
      return truncateString(inner, clip);
    case 'arrayValue': {
      if (depth >= MAX_VALUE_DEPTH) {
        clip.truncated = true;
        return TRUNCATION_MARKER;
      }
      if (!isObject(inner)) throw new RecordError(`${what}.arrayValue must be an object`);
      checkKeys(inner, ['values'], `${what}.arrayValue`);
      const values = inner.values ?? [];
      if (!Array.isArray(values))
        throw new RecordError(`${what}.arrayValue.values must be an array`);
      if (values.length > MAX_ARRAY_ITEMS) clip.truncated = true;
      return values
        .slice(0, MAX_ARRAY_ITEMS)
        .map((item, i) => anyValue(item, depth + 1, clip, `${what}[${i}]`));
    }
    case 'kvlistValue': {
      if (depth >= MAX_VALUE_DEPTH) {
        clip.truncated = true;
        return TRUNCATION_MARKER;
      }
      if (!isObject(inner)) throw new RecordError(`${what}.kvlistValue must be an object`);
      checkKeys(inner, ['values'], `${what}.kvlistValue`);
      return keyValues(inner.values ?? [], depth + 1, clip, `${what}.kvlistValue.values`);
    }
  }
}

/**
 * Convert an OTLP KeyValue list to a plain object. Keys must be unique.
 * Built with Object.fromEntries so a `__proto__` key stays an own property.
 */
function keyValues(list: unknown, depth: number, clip: Clip, what: string): Plain {
  if (!Array.isArray(list)) throw new RecordError(`${what} must be an array`);
  if (list.length > MAX_ATTRIBUTES) clip.truncated = true;
  const seen = new Set<string>();
  const entries: [string, unknown][] = [];
  for (const [i, kv] of list.slice(0, MAX_ATTRIBUTES).entries()) {
    if (!isObject(kv)) throw new RecordError(`${what}[${i}] must be a {key, value} object`);
    checkKeys(kv, ['key', 'value'], `${what}[${i}]`);
    const key = kv.key;
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_CHARS) {
      throw new RecordError(`${what}[${i}].key must be a 1-${MAX_KEY_CHARS} char string`);
    }
    if (seen.has(key)) throw new RecordError(`${what}: duplicate key "${key}"`);
    seen.add(key);
    // A missing value is an empty AnyValue.
    entries.push([
      key,
      kv.value === undefined ? null : anyValue(kv.value, depth, clip, `${what}.${key}`),
    ]);
  }
  return Object.fromEntries(entries);
}

function optionalCount(obj: Plain, what: string): number | undefined {
  return obj.droppedAttributesCount === undefined
    ? undefined
    : uint32(obj.droppedAttributesCount, `${what}.droppedAttributesCount`);
}

/** The flattened resource or scope context shared by every record under it. */
interface Context {
  resource: Plain;
  resourceSchemaUrl?: string;
  scope: AuditLine['scope'];
  scopeSchemaUrl?: string;
  /** Truncation inside the resource/scope, inherited by each record. */
  truncated: boolean;
}

function parseResource(rl: Plain): Pick<Context, 'resource' | 'resourceSchemaUrl' | 'truncated'> {
  checkKeys(rl, ['resource', 'scopeLogs', 'schemaUrl'], 'resourceLogs');
  const clip: Clip = { truncated: false };
  let resource: Plain = {};
  if (rl.resource !== undefined) {
    if (!isObject(rl.resource)) throw new RecordError('resource must be an object');
    checkKeys(rl.resource, ['attributes', 'droppedAttributesCount'], 'resource');
    optionalCount(rl.resource, 'resource');
    resource = keyValues(rl.resource.attributes ?? [], 0, clip, 'resource.attributes');
  }
  return {
    resource,
    ...(rl.schemaUrl !== undefined && {
      resourceSchemaUrl: shortString(rl.schemaUrl, 'resourceLogs.schemaUrl'),
    }),
    truncated: clip.truncated,
  };
}

function parseScope(sl: Plain): Pick<Context, 'scope' | 'scopeSchemaUrl' | 'truncated'> {
  checkKeys(sl, ['scope', 'logRecords', 'schemaUrl'], 'scopeLogs');
  const clip: Clip = { truncated: false };
  const scope: AuditLine['scope'] = {};
  if (sl.scope !== undefined) {
    if (!isObject(sl.scope)) throw new RecordError('scope must be an object');
    checkKeys(sl.scope, ['name', 'version', 'attributes', 'droppedAttributesCount'], 'scope');
    optionalCount(sl.scope, 'scope');
    if (sl.scope.name !== undefined) scope.name = shortString(sl.scope.name, 'scope.name');
    if (sl.scope.version !== undefined) {
      scope.version = shortString(sl.scope.version, 'scope.version');
    }
    if (sl.scope.attributes !== undefined) {
      scope.attributes = keyValues(sl.scope.attributes, 0, clip, 'scope.attributes');
    }
  }
  return {
    scope,
    ...(sl.schemaUrl !== undefined && {
      scopeSchemaUrl: shortString(sl.schemaUrl, 'scopeLogs.schemaUrl'),
    }),
    truncated: clip.truncated,
  };
}

const LOG_RECORD_KEYS = [
  'timeUnixNano',
  'observedTimeUnixNano',
  'severityNumber',
  'severityText',
  'eventName',
  'body',
  'attributes',
  'droppedAttributesCount',
  'flags',
  'traceId',
  'spanId',
  // drawlatch extension: OTLP has no parent span on a log record.
  'parentSpanId',
] as const;

/** Everything in a stored line except the server stamps. */
type ParsedRecord = Omit<
  AuditLine,
  'drawlatch.caller' | 'drawlatch.received_at' | 'drawlatch.sequence'
>;

function parseRecord(rec: unknown, ctx: Context): ParsedRecord {
  if (!isObject(rec)) throw new RecordError('logRecord must be an object');
  checkKeys(rec, LOG_RECORD_KEYS, 'logRecord');
  const clip: Clip = { truncated: ctx.truncated };
  // Record fields first, then attributes and the shared context, so a line
  // reads top-down. Key order is cosmetic; nothing depends on it.
  const out: Partial<ParsedRecord> = {};

  if (rec.timeUnixNano !== undefined) out.time_unix_nano = uint64(rec.timeUnixNano, 'timeUnixNano');
  if (rec.observedTimeUnixNano !== undefined) {
    out.observed_time_unix_nano = uint64(rec.observedTimeUnixNano, 'observedTimeUnixNano');
  }
  if (rec.severityNumber !== undefined) {
    const n = rec.severityNumber;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 24) {
      throw new RecordError('severityNumber must be an integer 0-24');
    }
    out.severity_number = n;
  }
  if (rec.severityText !== undefined)
    out.severity_text = shortString(rec.severityText, 'severityText');
  if (rec.eventName !== undefined) out.event_name = shortString(rec.eventName, 'eventName');
  // An empty id means unset in OTLP/JSON: leave the field out.
  const traceId = rec.traceId === undefined ? undefined : hexId(rec.traceId, 32, 'traceId');
  if (traceId !== undefined) out.trace_id = traceId;
  const spanId = rec.spanId === undefined ? undefined : hexId(rec.spanId, 16, 'spanId');
  if (spanId !== undefined) out.span_id = spanId;
  const parentSpanId =
    rec.parentSpanId === undefined ? undefined : hexId(rec.parentSpanId, 16, 'parentSpanId');
  if (parentSpanId !== undefined) out.parent_span_id = parentSpanId;
  if (rec.flags !== undefined) out.flags = uint32(rec.flags, 'flags');
  if (rec.body !== undefined) out.body = anyValue(rec.body, 0, clip, 'body');
  out.attributes =
    rec.attributes === undefined ? {} : keyValues(rec.attributes, 0, clip, 'attributes');
  const dropped = optionalCount(rec, 'logRecord');
  if (dropped !== undefined) out.dropped_attributes_count = dropped;
  out.resource = ctx.resource;
  if (ctx.resourceSchemaUrl !== undefined) out.resource_schema_url = ctx.resourceSchemaUrl;
  out.scope = ctx.scope;
  if (ctx.scopeSchemaUrl !== undefined) out.scope_schema_url = ctx.scopeSchemaUrl;

  if (clip.truncated) out.truncated = true;
  return out as ParsedRecord;
}

/** Outcome of validating a whole request, before anything is written. */
export interface ParsedBatch {
  records: ParsedRecord[];
  rejected: number;
  /** One message per distinct reason, in first-seen order. */
  errors: string[];
}

/** Record a rejection reason once, bounded so a hostile batch can't bloat the reply. */
function noteReason(errors: string[], reason: string): void {
  const cut = reason.length > MAX_REASON_CHARS ? reason.slice(0, MAX_REASON_CHARS) + '…' : reason;
  if (errors.length < MAX_ERROR_REASONS && !errors.includes(cut)) errors.push(cut);
}

/**
 * Validate an ExportLogsServiceRequest. Throws only when the top level is not
 * an object with a `resourceLogs` array; everything below that is rejected
 * per record (a bad resource or scope rejects every record under it).
 */
export function parseIngestRequest(input: unknown): ParsedBatch {
  if (!isObject(input)) throw new Error('ingest_logs: input must be an object');
  const unknownTop = Object.keys(input).filter((k) => k !== 'resourceLogs');
  if (unknownTop.length > 0) {
    throw new Error(`ingest_logs: unknown field "${unknownTop[0]}"`);
  }
  const resourceLogs = input.resourceLogs ?? [];
  if (!Array.isArray(resourceLogs)) throw new Error('ingest_logs: resourceLogs must be an array');

  const batch: ParsedBatch = { records: [], rejected: 0, errors: [] };
  const reject = (count: number, reason: string): void => {
    batch.rejected += count;
    noteReason(batch.errors, reason);
  };
  /** How many records sit under a structure we couldn't parse. Best effort. */
  const countUnder = (logRecords: unknown): number =>
    Array.isArray(logRecords) ? Math.max(logRecords.length, 1) : 1;

  for (const rl of resourceLogs) {
    if (!isObject(rl)) {
      reject(1, 'resourceLogs entry must be an object');
      continue;
    }
    const scopeLogs = rl.scopeLogs ?? [];
    const scopeList: unknown[] = Array.isArray(scopeLogs) ? scopeLogs : [];
    let res: ReturnType<typeof parseResource>;
    try {
      if (!Array.isArray(scopeLogs)) throw new RecordError('scopeLogs must be an array');
      res = parseResource(rl);
    } catch (err) {
      const n = scopeList.reduce<number>(
        (sum, sl) => sum + (isObject(sl) ? countUnder(sl.logRecords) : 1),
        0,
      );
      reject(Math.max(n, 1), (err as Error).message);
      continue;
    }

    for (const sl of scopeList) {
      if (!isObject(sl)) {
        reject(1, 'scopeLogs entry must be an object');
        continue;
      }
      let scope: ReturnType<typeof parseScope>;
      try {
        if (sl.logRecords !== undefined && !Array.isArray(sl.logRecords)) {
          throw new RecordError('logRecords must be an array');
        }
        scope = parseScope(sl);
      } catch (err) {
        reject(countUnder(sl.logRecords), (err as Error).message);
        continue;
      }
      const ctx: Context = {
        resource: res.resource,
        scope: scope.scope,
        truncated: res.truncated || scope.truncated,
        ...(res.resourceSchemaUrl !== undefined && { resourceSchemaUrl: res.resourceSchemaUrl }),
        ...(scope.scopeSchemaUrl !== undefined && { scopeSchemaUrl: scope.scopeSchemaUrl }),
      };
      for (const rec of (sl.logRecords ?? []) as unknown[]) {
        if (batch.records.length >= MAX_RECORDS_PER_CALL) {
          reject(1, `more than ${MAX_RECORDS_PER_CALL} records in one call`);
          continue;
        }
        try {
          batch.records.push(parseRecord(rec, ctx));
        } catch (err) {
          if (!(err instanceof RecordError)) throw err;
          reject(1, err.message);
        }
      }
    }
  }
  return batch;
}

// ── Storage ────────────────────────────────────────────────────────────────

/**
 * Validate a caller alias for use as a path segment. Aliases come from the
 * authenticated session, but remote.config.json is hand-editable, so check
 * anyway rather than trust that every alias went through CALLER_ALIAS_REGEX.
 */
export function auditCallerDir(auditRoot: string, callerAlias: string): string {
  if (callerAlias.length > MAX_CALLER_ALIAS_CHARS || !CALLER_ALIAS_REGEX.test(callerAlias)) {
    throw new Error('ingest_logs: caller alias is not a safe path segment');
  }
  const root = path.resolve(auditRoot);
  const dir = path.resolve(root, callerAlias);
  if (path.dirname(dir) !== root) {
    throw new Error('ingest_logs: caller alias is not a safe path segment');
  }
  return dir;
}

export function auditRootDir(): string {
  return path.join(getConfigDir(), 'audit');
}

/** UTC calendar day, `YYYY-MM-DD`. */
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Create `dir` if needed and force it to 0700 (mkdir's mode is umask-filtered). */
async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(dir, 0o700);
}

/** Per-file state, loaded once per process. */
interface FileState {
  /** Last sequence number written to this file. */
  lastSequence: number;
}

const fileStates = new Map<string, FileState>();
/** Tail of the per-file write chain: one append in flight per file. */
const fileQueues = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier write to `file` has settled. */
function serialize<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileQueues.get(file) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  fileQueues.set(file, tail);
  void tail.then(() => {
    if (fileQueues.get(file) === tail) fileQueues.delete(file);
  });
  return next;
}

/** Highest `drawlatch.sequence` among the complete JSON lines in `text`. */
function maxSequence(text: string): number {
  let last = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const seq = (JSON.parse(line) as Plain)['drawlatch.sequence'];
      if (typeof seq === 'number' && seq > last) last = seq;
    } catch {
      // A torn line from a crash mid-write, or the cut first line of the tail.
    }
  }
  return last;
}

/**
 * Recover the last sequence number from an existing file. Sequences only grow
 * within a file, so the answer is in the last complete line: read a tail big
 * enough to hold a few maximum-size lines, and fall back to the whole file
 * only if the tail holds no parseable line (corruption, not the normal case).
 */
async function loadLastSequence(fh: fs.promises.FileHandle, size: number): Promise<number> {
  const tailBytes = Math.min(size, 4 * MAX_RECORD_BYTES);
  const tail = Buffer.alloc(tailBytes);
  await fh.read(tail, 0, tailBytes, size - tailBytes);
  const fromTail = maxSequence(tail.toString('utf8'));
  if (fromTail > 0 || tailBytes === size) return fromTail;
  return maxSequence((await fh.readFile()).toString('utf8'));
}

export interface IngestOptions {
  /** Override `<config dir>/audit` (tests). */
  auditRoot?: string;
  /** Override the receive time (tests). */
  now?: Date;
}

/**
 * Validate and append one `ingest_logs` batch for `callerAlias`.
 *
 * Every line in a call shares one received_at, so a batch lands in a single
 * day file and is written with one append. Appends to the same file are
 * serialized in-process, so concurrent calls never interleave partial lines,
 * and each append is fsync'd before we answer: a record we acknowledge is on
 * disk. Assumes one daemon process per config dir, which `drawlatch start`
 * already enforces with its PID file.
 */
export async function ingestLogs(
  input: unknown,
  callerAlias: string,
  options: IngestOptions = {},
): Promise<IngestLogsResponse> {
  const auditRoot = options.auditRoot ?? auditRootDir();
  const callerDir = auditCallerDir(auditRoot, callerAlias);
  const batch = parseIngestRequest(input);
  const receivedAt = options.now ?? new Date();
  const file = path.join(callerDir, `${utcDay(receivedAt)}.jsonl`);

  let rejected = batch.rejected;
  const errors = [...batch.errors];
  const addError = (reason: string, count: number): void => {
    rejected += count;
    noteReason(errors, reason);
  };

  if (batch.records.length > 0) {
    await ensurePrivateDir(auditRoot);
    await ensurePrivateDir(callerDir);

    await serialize(file, async () => {
      const fh = await fs.promises.open(file, 'a+', 0o600);
      try {
        await fh.chmod(0o600);
        const { size } = await fh.stat();
        let state = fileStates.get(file);
        if (!state) {
          state = { lastSequence: await loadLastSequence(fh, size) };
          fileStates.set(file, state);
        }

        // A crash mid-append can leave a torn last line. Start on a fresh
        // line so it can't swallow the first record of this batch.
        let prefix = '';
        if (size > 0) {
          const last = Buffer.alloc(1);
          await fh.read(last, 0, 1, size - 1);
          if (last[0] !== 0x0a) prefix = '\n';
        }

        const chunks: string[] = [];
        let callBytes = 0;
        let seq = state.lastSequence;
        const receivedIso = receivedAt.toISOString();
        for (const rec of batch.records) {
          const line: AuditLine = {
            'drawlatch.caller': callerAlias,
            'drawlatch.received_at': receivedIso,
            'drawlatch.sequence': seq + 1,
            ...rec,
          };
          const text = JSON.stringify(line) + '\n';
          const bytes = Buffer.byteLength(text);
          if (bytes > MAX_RECORD_BYTES) {
            addError(`record exceeds ${MAX_RECORD_BYTES} bytes after truncation`, 1);
            continue;
          }
          if (callBytes + bytes > MAX_BYTES_PER_CALL) {
            addError(`call exceeds ${MAX_BYTES_PER_CALL} stored bytes`, 1);
            continue;
          }
          if (size + callBytes + bytes > MAX_FILE_BYTES) {
            addError(`daily audit quota of ${MAX_FILE_BYTES} bytes reached for this caller`, 1);
            continue;
          }
          seq++;
          callBytes += bytes;
          chunks.push(text);
        }

        if (chunks.length > 0) {
          try {
            await fh.appendFile(prefix + chunks.join(''));
            await fh.datasync();
          } catch (err) {
            // Part of the batch may have landed. Re-read the file next time
            // rather than reuse sequence numbers that are already on disk.
            fileStates.delete(file);
            throw err;
          }
          state.lastSequence = seq;
        }
      } finally {
        await fh.close();
      }
    });
  }

  if (rejected === 0) return {};
  return { partialSuccess: { rejectedLogRecords: rejected, errorMessage: errors.join('; ') } };
}

/** Forget cached per-file sequence state (tests). */
export function resetAuditLogState(): void {
  fileStates.clear();
}
