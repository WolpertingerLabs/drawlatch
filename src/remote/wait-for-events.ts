/**
 * `wait_for_events` — a long-poll over every ingestor stream a caller owns.
 *
 * Replaces the `ingestor_status` + N×`poll_events` cycle a watcher otherwise
 * runs every few seconds: one request returns as soon as any of the caller's
 * streams has something past its cursor, or holds until one does (or the
 * timeout fires). A held wait costs one request against the per-session rate
 * limit, however long it holds.
 *
 * Stream key = `${connection}:${instanceId}`, with the manager's `_default`
 * sentinel for single-instance connections. Event ids are epoch-based per
 * ingestor instance, so each instance needs its own cursor — a cursor shared
 * across instances would skip events.
 *
 * Holding a request open is a resource, so it is capped: MAX_WAITS_PER_SESSION
 * concurrent holds per session and MAX_WAITS_TOTAL hub-wide. Over a cap the
 * call fails immediately instead of queueing.
 */

import type { IngestedEvent } from './ingestors/types.js';
import type { ToolContext } from './tool-dispatch.js';

// ── Limits ─────────────────────────────────────────────────────────────────

export const WAIT_DEFAULT_TIMEOUT_MS = 25_000;
export const WAIT_MAX_TIMEOUT_MS = 55_000;
export const MAX_WAITS_PER_SESSION = 2;
export const MAX_WAITS_TOTAL = 64;

/**
 * Resolve the hold duration: default 25s, clamped to [0, 55000].
 *
 * When the local proxy advertised an outbound budget (how long its own socket
 * will actually wait), the hold is clamped to that too, so a wait always
 * answers before the client gives up on it. Absent or malformed budget means
 * no clamp, matching applyOutboundBudget.
 */
export function clampWaitTimeout(requested: unknown, budgetMs?: unknown): number {
  let timeout: number;
  if (typeof requested !== 'number' || Number.isNaN(requested)) {
    timeout = WAIT_DEFAULT_TIMEOUT_MS;
  } else {
    timeout = Math.min(Math.max(requested, 0), WAIT_MAX_TIMEOUT_MS);
  }
  if (typeof budgetMs === 'number' && Number.isFinite(budgetMs) && budgetMs > 0) {
    timeout = Math.min(timeout, budgetMs);
  }
  return timeout;
}

// ── Hold accounting ────────────────────────────────────────────────────────

const holdsBySession = new Map<string, number>();
let totalHolds = 0;

/** Number of waits currently holding, hub-wide. */
export function activeWaitCount(): number {
  return totalHolds;
}

function acquireHold(sessionKey: string): void {
  const current = holdsBySession.get(sessionKey) ?? 0;
  if (current >= MAX_WAITS_PER_SESSION || totalHolds >= MAX_WAITS_TOTAL) {
    throw new Error('too many concurrent waits');
  }
  holdsBySession.set(sessionKey, current + 1);
  totalHolds++;
}

function releaseHold(sessionKey: string): void {
  const current = holdsBySession.get(sessionKey) ?? 0;
  if (current <= 1) holdsBySession.delete(sessionKey);
  else holdsBySession.set(sessionKey, current - 1);
  totalHolds--;
}

// ── Wire types ─────────────────────────────────────────────────────────────

export interface WaitForEventsStream {
  connection: string;
  instanceId: string;
  events: IngestedEvent[];
  /** Highest event id returned, or the input cursor when none were. */
  cursor: number;
}

export interface WaitForEventsResult {
  /** Every active stream for the caller, including ones with no new events. */
  streams: Record<string, WaitForEventsStream>;
  /** Cursor keys that named no active stream for this caller. */
  unknownStreams: string[];
  timedOut: boolean;
}

// ── Implementation ─────────────────────────────────────────────────────────

function parseCursors(raw: unknown): Record<string, number> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('cursors must be an object mapping stream keys to numeric event ids');
  }
  const cursors: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error(`cursors["${key}"] must be a number`);
    }
    cursors[key] = value;
  }
  return cursors;
}

/** Snapshot every stream of the caller against the cursors. */
function collect(
  context: ToolContext,
  cursors: Record<string, number>,
): { result: WaitForEventsResult; hasEvents: boolean } {
  const streams: Record<string, WaitForEventsStream> = {};
  let hasEvents = false;

  for (const s of context.ingestorManager.getStreams(context.callerAlias)) {
    const key = `${s.connection}:${s.instanceId}`;
    const after = Object.hasOwn(cursors, key) ? cursors[key] : -1;
    const events = s.ingestor.getEvents(after);
    let cursor = after;
    for (const e of events) if (e.id > cursor) cursor = e.id;
    if (events.length > 0) hasEvents = true;
    streams[key] = { connection: s.connection, instanceId: s.instanceId, events, cursor };
  }

  const unknownStreams = Object.keys(cursors).filter((k) => !Object.hasOwn(streams, k));
  return { result: { streams, unknownStreams, timedOut: false }, hasEvents };
}

/**
 * Run one `wait_for_events` call. `context.signal` aborts a hold (the remote
 * server wires it to the HTTP request closing); `context.sessionId` scopes the
 * per-session cap.
 */
export function waitForEvents(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<WaitForEventsResult> {
  const cursors = parseCursors(input.cursors);
  const timeoutMs = clampWaitTimeout(input.timeout_ms, context.outboundBudgetMs);
  const { signal } = context;

  const first = collect(context, cursors);
  if (first.hasEvents) return Promise.resolve(first.result);
  if (timeoutMs === 0) return Promise.resolve({ ...first.result, timedOut: true });
  if (signal?.aborted) return Promise.reject(new Error('wait aborted: client disconnected'));

  // The admin API has no session; key it by caller so it is still capped.
  const sessionKey = context.sessionId ?? `caller:${context.callerAlias}`;
  acquireHold(sessionKey);

  const mgr = context.ingestorManager;

  return new Promise<WaitForEventsResult>((resolve, reject) => {
    let done = false;

    const finish = (outcome: () => WaitForEventsResult | Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      mgr.offEvent(onEvent);
      signal?.removeEventListener('abort', onAbort);
      releaseHold(sessionKey);
      let value: WaitForEventsResult | Error;
      try {
        value = outcome();
      } catch (err) {
        value = err instanceof Error ? err : new Error(String(err));
      }
      if (value instanceof Error) reject(value);
      else resolve(value);
    };

    // Collection is synchronous and the listener is registered in the same
    // tick as the first check, so no event can slip between the two.
    function onEvent(event: IngestedEvent): void {
      if (event.callerAlias !== context.callerAlias) return;
      // A wake whose stream has nothing past its cursor (cursor ahead of the
      // buffer) keeps holding rather than answering empty.
      let next: ReturnType<typeof collect>;
      try {
        next = collect(context, cursors);
      } catch (err) {
        finish(() => (err instanceof Error ? err : new Error(String(err))));
        return;
      }
      if (next.hasEvents) finish(() => next.result);
    }

    function onAbort(): void {
      finish(() => new Error('wait aborted: client disconnected'));
    }

    const timer = setTimeout(() => {
      finish(() => {
        const last = collect(context, cursors);
        return last.hasEvents ? last.result : { ...last.result, timedOut: true };
      });
    }, timeoutMs);

    mgr.onEvent(onEvent);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
