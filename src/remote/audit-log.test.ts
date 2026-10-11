import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  auditCallerDir,
  ingestLogs,
  parseIngestRequest,
  resetAuditLogState,
  MAX_ARRAY_ITEMS,
  MAX_ATTRIBUTES,
  MAX_BYTES_PER_CALL,
  MAX_FILE_BYTES,
  MAX_RECORDS_PER_CALL,
  MAX_RECORD_BYTES,
  MAX_STRING_CHARS,
  MAX_VALUE_DEPTH,
  TRUNCATION_MARKER,
  type AuditLine,
} from './audit-log.js';

const NOW = new Date('2026-10-11T12:00:00.000Z');
const TRACE = '0123456789abcdef0123456789abcdef';
const SPAN = '0123456789abcdef';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-audit-'));
  resetAuditLogState();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function str(v: string) {
  return { stringValue: v };
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timeUnixNano: '1760184000000000000',
    observedTimeUnixNano: '1760184000000000001',
    severityNumber: 9,
    severityText: 'INFO',
    eventName: 'permission.review.requested',
    body: str('hello'),
    attributes: [{ key: 'tool.name', value: str('Bash') }],
    traceId: TRACE,
    spanId: SPAN,
    flags: 1,
    ...overrides,
  };
}

function request(records: unknown[], extra: { resource?: unknown; scope?: unknown } = {}) {
  return {
    resourceLogs: [
      {
        resource: extra.resource ?? {
          attributes: [{ key: 'service.name', value: str('callboard') }],
        },
        scopeLogs: [
          {
            scope: extra.scope ?? { name: 'callboard.permission-review', version: '1' },
            logRecords: records,
          },
        ],
      },
    ],
  };
}

function ingest(input: unknown, caller = 'callboard', now = NOW) {
  return ingestLogs(input, caller, { auditRoot: root, now });
}

function fileFor(caller = 'callboard', day = '2026-10-11'): string {
  return path.join(root, caller, `${day}.jsonl`);
}

function readLines(file = fileFor()): AuditLine[] {
  const text = fs.readFileSync(file, 'utf8');
  expect(text.endsWith('\n')).toBe(true);
  return text
    .slice(0, -1)
    .split('\n')
    .map((l) => JSON.parse(l) as AuditLine);
}

describe('ingest_logs storage format', () => {
  it('stores one flattened line per record with server stamps', async () => {
    const res = await ingest(request([record({ parentSpanId: 'FEDCBA9876543210' })]));
    expect(res).toEqual({});

    const [line] = readLines();
    expect(line).toEqual({
      'drawlatch.caller': 'callboard',
      'drawlatch.received_at': NOW.toISOString(),
      'drawlatch.sequence': 1,
      time_unix_nano: '1760184000000000000',
      observed_time_unix_nano: '1760184000000000001',
      severity_number: 9,
      severity_text: 'INFO',
      event_name: 'permission.review.requested',
      trace_id: TRACE,
      span_id: SPAN,
      parent_span_id: 'fedcba9876543210',
      flags: 1,
      body: 'hello',
      attributes: { 'tool.name': 'Bash' },
      resource: { 'service.name': 'callboard' },
      scope: { name: 'callboard.permission-review', version: '1' },
    });
  });

  it('flattens every AnyValue kind', async () => {
    await ingest(
      request([
        record({
          attributes: [
            { key: 's', value: str('x') },
            { key: 'b', value: { boolValue: false } },
            { key: 'i', value: { intValue: '42' } },
            { key: 'n', value: { intValue: 7 } },
            { key: 'big', value: { intValue: '9223372036854775807' } },
            { key: 'neg', value: { intValue: '-5' } },
            { key: 'd', value: { doubleValue: 1.5 } },
            { key: 'bytes', value: { bytesValue: 'aGk=' } },
            { key: 'arr', value: { arrayValue: { values: [str('a'), { intValue: 1 }] } } },
            { key: 'kv', value: { kvlistValue: { values: [{ key: 'k', value: str('v') }] } } },
            { key: 'empty', value: {} },
            { key: 'missing' },
          ],
        }),
      ]),
    );
    expect(readLines()[0].attributes).toEqual({
      s: 'x',
      b: false,
      i: 42,
      n: 7,
      big: '9223372036854775807',
      neg: -5,
      d: 1.5,
      bytes: 'aGk=',
      arr: ['a', 1],
      kv: { k: 'v' },
      empty: null,
      missing: null,
    });
  });

  it('omits ids that OTLP/JSON sends as empty strings', async () => {
    await ingest(request([record({ traceId: '', spanId: '', parentSpanId: '' })]));
    const [line] = readLines();
    expect(line).not.toHaveProperty('trace_id');
    expect(line).not.toHaveProperty('span_id');
    expect(line).not.toHaveProperty('parent_span_id');
  });

  it('keeps a __proto__ key as plain data', async () => {
    await ingest(request([record({ attributes: [{ key: '__proto__', value: str('x') }] })]));
    const raw = fs.readFileSync(fileFor(), 'utf8');
    expect(raw).toContain('"__proto__":"x"');
  });

  it('accepts an empty request and creates nothing', async () => {
    expect(await ingest({})).toEqual({});
    expect(await ingest({ resourceLogs: [] })).toEqual({});
    expect(fs.existsSync(path.join(root, 'callboard'))).toBe(false);
  });

  it('names the file by the UTC day of receipt', async () => {
    // 23:30 in New York on the 11th is the 12th in UTC.
    await ingest(request([record()]), 'callboard', new Date('2026-10-11T23:30:00-04:00'));
    expect(fs.existsSync(fileFor('callboard', '2026-10-12'))).toBe(true);
  });
});

describe('ingest_logs validation', () => {
  it('throws on a malformed top level', async () => {
    await expect(ingest(null)).rejects.toThrow(/must be an object/);
    await expect(ingest([])).rejects.toThrow(/must be an object/);
    await expect(ingest({ resourceLogs: {} })).rejects.toThrow(/must be an array/);
    await expect(ingest({ resourceLogs: [], extra: 1 })).rejects.toThrow(/unknown field/);
  });

  it.each([
    ['not an object', 'nope'],
    ['unknown field', record({ evil: true })],
    ['short traceId', record({ traceId: 'abc' })],
    ['non-hex spanId', record({ spanId: 'zzzzzzzzzzzzzzzz' })],
    ['bad parentSpanId', record({ parentSpanId: TRACE })],
    ['severity out of range', record({ severityNumber: 25 })],
    ['fractional severity', record({ severityNumber: 1.5 })],
    ['negative time', record({ timeUnixNano: -1 })],
    ['time overflow', record({ timeUnixNano: '18446744073709551616' })],
    ['time not a number', record({ timeUnixNano: '12abc' })],
    ['flags too big', record({ flags: 2 ** 32 })],
    ['long eventName', record({ eventName: 'e'.repeat(257) })],
    ['non-string severityText', record({ severityText: 3 })],
    ['body not AnyValue', record({ body: 'plain' })],
    ['body with two kinds', record({ body: { stringValue: 'a', boolValue: true } })],
    ['unknown AnyValue kind', record({ body: { mapValue: {} } })],
    ['NaN double', record({ body: { doubleValue: Number.NaN } })],
    ['int64 overflow', record({ body: { intValue: '9223372036854775808' } })],
    ['unsafe int number', record({ body: { intValue: 2 ** 60 } })],
    ['bad base64', record({ body: { bytesValue: '!!' } })],
    ['attributes not array', record({ attributes: {} })],
    [
      'duplicate attribute key',
      record({
        attributes: [
          { key: 'a', value: str('1') },
          { key: 'a', value: str('2') },
        ],
      }),
    ],
    ['empty attribute key', record({ attributes: [{ key: '', value: str('1') }] })],
    ['long attribute key', record({ attributes: [{ key: 'k'.repeat(257), value: str('1') }] })],
    ['extra field on KeyValue', record({ attributes: [{ key: 'a', value: str('1'), x: 1 }] })],
  ])('rejects a record with %s and keeps the rest', async (_name, bad) => {
    const res = await ingest(request([record(), bad, record()]));
    expect(res.partialSuccess?.rejectedLogRecords).toBe(1);
    expect(typeof res.partialSuccess?.errorMessage).toBe('string');
    expect(readLines().map((l) => l['drawlatch.sequence'])).toEqual([1, 2]);
  });

  it('rejects every record under a malformed resource or scope', async () => {
    const res = await ingest({
      resourceLogs: [
        { resource: { attributes: 'bad' }, scopeLogs: [{ logRecords: [record(), record()] }] },
        { scopeLogs: [{ scope: { name: 5 }, logRecords: [record(), record(), record()] }] },
        { scopeLogs: [{ logRecords: [record()] }] },
      ],
    });
    expect(res.partialSuccess?.rejectedLogRecords).toBe(5);
    expect(readLines()).toHaveLength(1);
  });

  it('bounds the error message', async () => {
    const bad = Array.from({ length: 50 }, (_, i) => record({ [`f${i}${'x'.repeat(500)}`]: 1 }));
    const res = await ingest(request(bad));
    expect(res.partialSuccess?.rejectedLogRecords).toBe(50);
    expect(res.partialSuccess?.errorMessage.length).toBeLessThan(3000);
  });
});

describe('ingest_logs size bounds', () => {
  it(`rejects records past ${MAX_RECORDS_PER_CALL} per call`, async () => {
    const records = Array.from({ length: MAX_RECORDS_PER_CALL + 5 }, () => record());
    const res = await ingest(request(records));
    expect(res.partialSuccess?.rejectedLogRecords).toBe(5);
    expect(res.partialSuccess?.errorMessage).toMatch(/more than 1000 records/);
    expect(readLines()).toHaveLength(MAX_RECORDS_PER_CALL);
  });

  it('truncates long strings with a marker and flags the line', async () => {
    const long = 'a'.repeat(MAX_STRING_CHARS + 10);
    await ingest(request([record({ body: str(long) }), record()]));
    const [cut, whole] = readLines();
    expect(cut.body).toBe('a'.repeat(MAX_STRING_CHARS) + TRUNCATION_MARKER);
    expect(cut.truncated).toBe(true);
    expect(whole.truncated).toBeUndefined();
  });

  it('does not split a surrogate pair when truncating', async () => {
    const long = 'a'.repeat(MAX_STRING_CHARS - 1) + '😀' + 'b';
    await ingest(request([record({ body: str(long) })]));
    expect(readLines()[0].body).toBe('a'.repeat(MAX_STRING_CHARS - 1) + TRUNCATION_MARKER);
  });

  it('caps attribute count and array length', async () => {
    const attrs = Array.from({ length: MAX_ATTRIBUTES + 3 }, (_, i) => ({
      key: `k${i}`,
      value: str('v'),
    }));
    const items = Array.from({ length: MAX_ARRAY_ITEMS + 3 }, () => ({ intValue: 1 }));
    await ingest(
      request([record({ attributes: attrs }), record({ body: { arrayValue: { values: items } } })]),
    );
    const [a, b] = readLines();
    expect(Object.keys(a.attributes)).toHaveLength(MAX_ATTRIBUTES);
    expect(a.truncated).toBe(true);
    expect(b.body).toHaveLength(MAX_ARRAY_ITEMS);
    expect(b.truncated).toBe(true);
  });

  it(`collapses nesting deeper than ${MAX_VALUE_DEPTH}`, async () => {
    let value: unknown = str('leaf');
    for (let i = 0; i < MAX_VALUE_DEPTH + 2; i++) value = { arrayValue: { values: [value] } };
    await ingest(request([record({ body: value })]));
    const [line] = readLines();
    let node = line.body;
    let depth = 0;
    while (Array.isArray(node)) {
      node = node[0];
      depth++;
    }
    expect(depth).toBe(MAX_VALUE_DEPTH);
    expect(node).toBe(TRUNCATION_MARKER);
    expect(line.truncated).toBe(true);
  });

  it('marks lines whose resource was truncated', async () => {
    await ingest(
      request([record()], {
        resource: { attributes: [{ key: 'x', value: str('r'.repeat(MAX_STRING_CHARS + 1)) }] },
      }),
    );
    expect(readLines()[0].truncated).toBe(true);
  });

  it(`rejects a record still over ${MAX_RECORD_BYTES} bytes after truncation`, async () => {
    const attrs = Array.from({ length: 20 }, (_, i) => ({
      key: `k${i}`,
      value: str('x'.repeat(MAX_STRING_CHARS)),
    }));
    const res = await ingest(request([record({ attributes: attrs }), record()]));
    expect(res.partialSuccess?.rejectedLogRecords).toBe(1);
    expect(res.partialSuccess?.errorMessage).toMatch(/after truncation/);
    expect(readLines()).toHaveLength(1);
  });

  it(`stops storing at ${MAX_BYTES_PER_CALL} bytes per call`, async () => {
    // ~245 KB per record, under the per-record cap.
    const attrs = Array.from({ length: 15 }, (_, i) => ({
      key: `k${i}`,
      value: str('x'.repeat(MAX_STRING_CHARS)),
    }));
    const res = await ingest(
      request(Array.from({ length: 20 }, () => record({ attributes: attrs }))),
    );
    const stored = fs.statSync(fileFor()).size;
    expect(stored).toBeLessThanOrEqual(MAX_BYTES_PER_CALL);
    const kept = readLines().length;
    expect(kept).toBeGreaterThan(10);
    expect(res.partialSuccess?.rejectedLogRecords).toBe(20 - kept);
    expect(res.partialSuccess?.errorMessage).toMatch(/stored bytes/);
  });

  it(`enforces the ${MAX_FILE_BYTES}-byte daily quota per caller`, async () => {
    const file = fileFor();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Sparse file just under the quota, ending in a valid line.
    const tailLine =
      JSON.stringify({ 'drawlatch.caller': 'callboard', 'drawlatch.sequence': 41 }) + '\n';
    fs.writeFileSync(file, '');
    fs.truncateSync(file, MAX_FILE_BYTES - 200 - tailLine.length);
    fs.appendFileSync(file, tailLine);

    const res = await ingest(request([record()]));
    expect(res.partialSuccess?.errorMessage).toMatch(/daily audit quota/);
    expect(fs.statSync(file).size).toBe(MAX_FILE_BYTES - 200);
  });
});

describe('ingest_logs caller stamping', () => {
  it('stamps the authenticated caller whatever the payload claims', async () => {
    await ingest(
      request(
        [
          record({
            attributes: [
              { key: 'drawlatch.caller', value: str('admin') },
              { key: 'drawlatch.sequence', value: { intValue: 999 } },
              { key: 'drawlatch.received_at', value: str('1970-01-01T00:00:00Z') },
            ],
          }),
        ],
        { resource: { attributes: [{ key: 'drawlatch.caller', value: str('admin') }] } },
      ),
      'callboard',
    );
    const [line] = readLines();
    expect(line['drawlatch.caller']).toBe('callboard');
    expect(line['drawlatch.sequence']).toBe(1);
    expect(line['drawlatch.received_at']).toBe(NOW.toISOString());
    // The claims survive only as nested, client-supplied data.
    expect(line.attributes['drawlatch.caller']).toBe('admin');
    expect(line.resource['drawlatch.caller']).toBe('admin');
    expect(fs.existsSync(path.join(root, 'admin'))).toBe(false);
  });

  it('rejects top-level stamp fields in a record', async () => {
    const res = await ingest(request([record({ 'drawlatch.caller': 'admin' })]));
    expect(res.partialSuccess?.rejectedLogRecords).toBe(1);
    expect(fs.existsSync(fileFor())).toBe(false);
  });

  it('keeps callers in separate directories and sequences', async () => {
    await ingest(request([record()]), 'alpha');
    await ingest(request([record(), record()]), 'beta');
    expect(readLines(fileFor('alpha')).map((l) => l['drawlatch.sequence'])).toEqual([1]);
    expect(readLines(fileFor('beta')).map((l) => l['drawlatch.sequence'])).toEqual([1, 2]);
  });
});

describe('ingest_logs path safety', () => {
  it.each(['..', '.', '../evil', 'a/b', 'a\\b', '', '-lead', 'a\0b', 'x'.repeat(129), '/abs'])(
    'refuses caller alias %j',
    async (alias) => {
      expect(() => auditCallerDir(root, alias)).toThrow(/safe path segment/);
      await expect(ingest(request([record()]), alias)).rejects.toThrow(/safe path segment/);
    },
  );

  it('writes nothing outside the audit root for a refused alias', async () => {
    await expect(ingest(request([record()]), '../escape')).rejects.toThrow();
    expect(fs.readdirSync(root)).toEqual([]);
    expect(fs.existsSync(path.join(path.dirname(root), 'escape'))).toBe(false);
  });

  it('accepts ordinary aliases', () => {
    expect(auditCallerDir(root, 'callboard_2-x')).toBe(path.join(root, 'callboard_2-x'));
  });
});

describe('ingest_logs append-only writes', () => {
  it('serializes concurrent calls into whole, contiguous lines', async () => {
    const calls = 40;
    const perCall = 25;
    const pad = 'p'.repeat(4000);
    await Promise.all(
      Array.from({ length: calls }, (_, c) =>
        ingest(
          request(
            Array.from({ length: perCall }, (_, r) => record({ body: str(`${c}:${r}:${pad}`) })),
          ),
        ),
      ),
    );

    const lines = readLines();
    expect(lines).toHaveLength(calls * perCall);
    expect(lines.map((l) => l['drawlatch.sequence'])).toEqual(
      Array.from({ length: calls * perCall }, (_, i) => i + 1),
    );
    // Each call's records land together and in order.
    for (let i = 0; i < lines.length; i += perCall) {
      const chunk = lines.slice(i, i + perCall).map((l) => (l.body as string).split(':'));
      expect(new Set(chunk.map(([c]) => c)).size).toBe(1);
      expect(chunk.map(([, r]) => Number(r))).toEqual(Array.from({ length: perCall }, (_, r) => r));
    }
  });

  it('continues the sequence after a restart', async () => {
    await ingest(request([record(), record()]));
    resetAuditLogState();
    await ingest(request([record()]));
    expect(readLines().map((l) => l['drawlatch.sequence'])).toEqual([1, 2, 3]);
  });

  it('isolates a torn last line left by a crash', async () => {
    await ingest(request([record()]));
    fs.appendFileSync(fileFor(), '{"drawlatch.caller":"callboard","drawlatch.seq');
    resetAuditLogState();
    await ingest(request([record()]));

    const raw = fs.readFileSync(fileFor(), 'utf8').split('\n');
    expect(raw[1]).toBe('{"drawlatch.caller":"callboard","drawlatch.seq');
    expect((JSON.parse(raw[2]) as AuditLine)['drawlatch.sequence']).toBe(2);
  });

  it('never rewrites earlier lines', async () => {
    await ingest(request([record()]));
    const before = fs.readFileSync(fileFor(), 'utf8');
    await ingest(request([record({ eventName: 'second' })]));
    expect(fs.readFileSync(fileFor(), 'utf8').startsWith(before)).toBe(true);
  });
});

describe('ingest_logs file modes', () => {
  it('creates 0600 files and 0700 dirs even under a permissive umask', async () => {
    const old = process.umask(0);
    try {
      await ingest(request([record()]));
    } finally {
      process.umask(old);
    }
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, 'callboard')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(fileFor()).mode & 0o777).toBe(0o600);
  });

  it('tightens pre-existing loose permissions', async () => {
    fs.mkdirSync(path.join(root, 'callboard'), { mode: 0o755 });
    fs.chmodSync(path.join(root, 'callboard'), 0o755);
    fs.writeFileSync(fileFor(), '', { mode: 0o644 });
    fs.chmodSync(fileFor(), 0o644);
    await ingest(request([record()]));
    expect(fs.statSync(path.join(root, 'callboard')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(fileFor()).mode & 0o777).toBe(0o600);
  });
});

describe('parseIngestRequest', () => {
  it('does no I/O and reports counts', () => {
    const parsed = parseIngestRequest(request([record(), 'bad']));
    expect(parsed.records).toHaveLength(1);
    expect(parsed.rejected).toBe(1);
  });
});
