import { useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Radio, RefreshCw } from "lucide-react";
import type { AdminCaller, AdminEvent, AdminIngestor, IngestorState } from "drawlatch-admin-types";
import { api, isDaemonDown } from "../api";
import { useDaemon } from "../contexts/DaemonContext";
import { useIsMobile } from "../hooks/useIsMobile";
import { useNow, usePolling } from "../hooks/usePolling";
import DaemonOffline from "../components/DaemonOffline";
import EmptyState, { LoadingState } from "../components/EmptyState";
import { plural, timeAgo } from "../utils/format";
import "./EventsView.css";

const POLL_INTERVAL_MS = 5_000;
const PREVIEW_LEN = 120;
/** The feed keeps scrolling back past the daemon's per-listener buffer, up
 *  to this many events; the oldest drop off. */
const MAX_EVENTS = 1_000;

const STATE_BADGE: Record<IngestorState, string> = {
  connected: "badge-success",
  starting: "badge-warning",
  reconnecting: "badge-warning",
  error: "badge-danger",
  stopped: "badge-muted",
};

const STATE_DOT: Record<IngestorState, string> = {
  connected: "up",
  starting: "warn",
  reconnecting: "warn",
  error: "down",
  stopped: "stopped",
};

/**
 * An event's identity. Ids are only unique per listener (boot second × 1e6 +
 * a counter), so two listeners started in the same second hand out the same
 * ids; the source and instance make it unique.
 */
export function eventKey(e: Pick<AdminEvent, "source" | "instanceId" | "id">): string {
  return `${e.source}:${e.instanceId ?? ""}:${e.id}`;
}

/** Newest first: by receive time, then id. */
function newestFirst(a: AdminEvent, b: AdminEvent): number {
  return b.receivedAtMs - a.receivedAtMs || b.id - a.id;
}

/**
 * Adds the events not seen yet to the list, newest first, capped at
 * MAX_EVENTS. Returns `prev` itself when nothing is new, so React skips the
 * render.
 */
export function mergeEvents(prev: AdminEvent[], incoming: readonly AdminEvent[]): AdminEvent[] {
  if (incoming.length === 0) return prev;
  const seen = new Set(prev.map(eventKey));
  const novel = incoming.filter((e) => !seen.has(eventKey(e)));
  if (novel.length === 0) return prev;
  return [...novel, ...prev].sort(newestFirst).slice(0, MAX_EVENTS);
}

/** Short, single-line preview of an event's unknown `data` payload. */
function dataPreview(data: unknown): string {
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else if (data === null || data === undefined || typeof data !== "object") {
    text = String(data);
  } else {
    try {
      text = JSON.stringify(data);
    } catch {
      text = String(data);
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > PREVIEW_LEN ? `${text.slice(0, PREVIEW_LEN)}…` : text;
}

/** Pretty-printed JSON for the expanded detail. */
function prettyData(data: unknown): string {
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function pickDefaultCaller(callers: AdminCaller[]): string | null {
  if (callers.length === 0) return null;
  return callers.some((c) => c.alias === "default") ? "default" : callers[0].alias;
}

type CallersState =
  | { status: "loading" }
  | { status: "ok"; callers: AdminCaller[] }
  | { status: "error"; message: string };

export default function EventsView() {
  const { daemon } = useDaemon();
  const now = useNow();

  const [callersState, setCallersState] = useState<CallersState>({ status: "loading" });
  const [selectedCaller, setSelectedCallerState] = useState<string | null>(null);
  // The caller on screen right now, for async work that started earlier.
  const selectedRef = useRef<string | null>(null);

  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [ingestors, setIngestors] = useState<AdminIngestor[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const selectCaller = (alias: string | null) => {
    if (alias === selectedRef.current) return;
    selectedRef.current = alias;
    setSelectedCallerState(alias);
    // A different caller's feed starts empty.
    setEvents([]);
    setIngestors([]);
    setLoaded(false);
    setFeedError(null);
    setActiveSource(null);
    setExpandedKey(null);
  };

  // ── Caller list ─────────────────────────────────────────────────────────
  const { refresh: reloadCallers } = usePolling(
    async (ctx) => {
      const res = await api.callers();
      if (!ctx.active()) return;
      if (isDaemonDown(res)) {
        // Keep a list that loaded before; only a first failure is shown.
        setCallersState((prev) =>
          prev.status === "ok" ? prev : { status: "error", message: res.error },
        );
        return;
      }
      setCallersState({ status: "ok", callers: res });
      const current = selectedRef.current;
      selectCaller(
        current && res.some((c) => c.alias === current) ? current : pickDefaultCaller(res),
      );
    },
    // Callers change rarely; this only picks up ones created meanwhile.
    60_000,
    { enabled: daemon === "up" },
  );

  // ── Events + listeners for the selected caller ──────────────────────────
  //
  // We pass `after_id=-1` and dedupe client-side (mergeEvents) rather than
  // keep a cursor. A cursor drifted whenever a poll's update was dropped, and
  // ids aren't ordered across listeners anyway. The daemon's buffer is
  // bounded (default 100 per listener), so this stays small and any missed
  // update heals on the next poll.
  const { refresh } = usePolling(
    async (ctx) => {
      const caller = selectedCaller;
      if (!caller) return;
      const [evRes, ingRes] = await Promise.all([
        api.callerEvents(caller, -1),
        api.callerIngestors(caller),
      ]);
      if (!ctx.active() || selectedRef.current !== caller) return;
      if (isDaemonDown(evRes)) setFeedError(evRes.error);
      else {
        setEvents((prev) => mergeEvents(prev, evRes));
        setFeedError(null);
      }
      if (!isDaemonDown(ingRes)) setIngestors(ingRes);
      setLoaded(true);
    },
    POLL_INTERVAL_MS,
    { enabled: daemon === "up" && selectedCaller !== null, key: selectedCaller },
  );

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  };

  // ── Derived: source counts + filtered events ────────────────────────────
  const sourceCounts = new Map<string, number>();
  for (const ev of events) {
    sourceCounts.set(ev.source, (sourceCounts.get(ev.source) ?? 0) + 1);
  }
  const sources = [...sourceCounts.keys()].sort((a, b) => a.localeCompare(b));
  const filteredEvents = activeSource ? events.filter((e) => e.source === activeSource) : events;
  const callers = callersState.status === "ok" ? callersState.callers : [];

  const title = (
    <div>
      <h1 className="page-title">Events</h1>
      <div className="subtitle-meta">
        <span>Live event feed from a caller's listeners</span>
        <span className="dot-sep">·</span>
        <span>polling every 5s</span>
      </div>
    </div>
  );

  if (daemon === "down") {
    return (
      <>
        <header className="page-header">{title}</header>
        <DaemonOffline action="load events" />
      </>
    );
  }

  return (
    <>
      <header className="page-header">
        {title}
        <div className="dl-events-controls">
          <label className="dl-events-caller-select">
            <span className="field-label dl-events-caller-label">Caller</span>
            <select
              className="input"
              value={selectedCaller ?? ""}
              disabled={callers.length === 0}
              onChange={(e) => selectCaller(e.target.value || null)}
            >
              {callers.length === 0 && (
                <option value="">
                  {callersState.status === "loading" ? "Loading…" : "No callers"}
                </option>
              )}
              {callers.map((c) => (
                <option key={c.alias} value={c.alias}>
                  {c.name ? `${c.name} (${c.alias})` : c.alias}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void handleRefresh()}
            disabled={!selectedCaller || refreshing}
          >
            <RefreshCw size={14} className={refreshing ? "spinner" : undefined} aria-hidden="true" />
            Refresh
          </button>
        </div>
      </header>

      {callersState.status === "loading" && <LoadingState label="Loading callers…" />}

      {callersState.status === "error" && (
        <div className="banner banner-offline" role="status">
          <AlertTriangle size={14} aria-hidden="true" />
          <span className="banner-offline-text">
            Couldn't load callers: {callersState.message}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm banner-action"
            onClick={() => void reloadCallers()}
          >
            Try again
          </button>
        </div>
      )}

      {callersState.status === "ok" && callers.length === 0 && (
        <EmptyState
          icon={<Radio size={20} />}
          title="No callers yet"
          body="Create a caller on the Callers page; its listeners' events show up here."
        />
      )}

      {selectedCaller && (
        <>
          {ingestors.length > 0 && <ListenerSummary ingestors={ingestors} now={now} />}

          {feedError && loaded && (
            <div className="banner banner-warn" role="status">
              <AlertTriangle size={14} aria-hidden="true" />
              <span>
                {events.length > 0
                  ? `Couldn't refresh events: ${feedError}. Showing the events loaded so far.`
                  : `Couldn't load events: ${feedError}`}
              </span>
            </div>
          )}

          {sources.length > 0 && (
            <div className="dl-events-pills" role="group" aria-label="Filter by source">
              <button
                type="button"
                className={`dl-events-pill ${activeSource === null ? "is-active" : ""}`}
                aria-pressed={activeSource === null}
                onClick={() => setActiveSource(null)}
              >
                All <span className="dl-events-pill-count">{events.length}</span>
              </button>
              {sources.map((src) => (
                <button
                  key={src}
                  type="button"
                  className={`dl-events-pill ${activeSource === src ? "is-active" : ""}`}
                  aria-pressed={activeSource === src}
                  onClick={() => setActiveSource(activeSource === src ? null : src)}
                >
                  <span className="mono">{src}</span>
                  <span className="dl-events-pill-count">{sourceCounts.get(src)}</span>
                </button>
              ))}
            </div>
          )}

          {!loaded ? (
            <LoadingState label="Loading events…" />
          ) : filteredEvents.length === 0 ? (
            feedError ? null : (
              <EmptyState
                icon={<Radio size={20} />}
                title="No events yet"
                body="Events from this caller's listeners appear here as they arrive."
              />
            )
          ) : (
            <div className="dl-events-feed">
              {filteredEvents.map((ev) => {
                const key = eventKey(ev);
                return (
                  <EventRow
                    key={key}
                    ev={ev}
                    now={now}
                    expanded={expandedKey === key}
                    onToggle={() => setExpandedKey(expandedKey === key ? null : key)}
                  />
                );
              })}
            </div>
          )}
        </>
      )}
    </>
  );
}

/** The caller's listeners: a one-line summary that opens into status cards.
 *  Open by default on wide screens; on a phone the cards would push the feed
 *  several screens down. */
function ListenerSummary({ ingestors, now }: { ingestors: AdminIngestor[]; now: number }) {
  const isMobile = useIsMobile();
  const counts = new Map<IngestorState, number>();
  for (const i of ingestors) counts.set(i.state, (counts.get(i.state) ?? 0) + 1);
  const order: IngestorState[] = ["connected", "reconnecting", "starting", "error", "stopped"];
  return (
    <details className="dl-events-listeners" open={!isMobile}>
      <summary className="dl-events-listeners-summary">
        <ChevronRight size={14} className="dl-events-chevron" aria-hidden="true" />
        <span className="dl-events-listeners-title">{plural(ingestors.length, "listener")}</span>
        {order
          .filter((st) => counts.get(st))
          .map((st) => (
            <span key={st} className="dl-events-listeners-count">
              <span className={`status-dot ${STATE_DOT[st]}`} aria-hidden="true" />
              {counts.get(st)} {st}
            </span>
          ))}
      </summary>
      <section className="dl-events-ingestors" aria-label="Listeners">
        {ingestors.map((ing) => (
          <ListenerCard key={`${ing.connection}::${ing.instanceId ?? ""}`} ing={ing} now={now} />
        ))}
      </section>
    </details>
  );
}

function ListenerCard({ ing, now }: { ing: AdminIngestor; now: number }) {
  const [showError, setShowError] = useState(false);
  return (
    <article className="dl-events-ingestor-card">
      <div className="dl-events-ingestor-head">
        <span className={`status-dot ${STATE_DOT[ing.state] ?? "stopped"}`} aria-hidden="true" />
        <span className="mono dl-events-ingestor-conn">{ing.connection}</span>
        {ing.instanceId && <span className="mono dl-events-instance">{ing.instanceId}</span>}
      </div>
      <div className="dl-events-ingestor-meta">
        <span className={`badge ${STATE_BADGE[ing.state] ?? "badge-muted"}`}>{ing.state}</span>
        <span className="badge badge-info">{ing.type}</span>
        <span>{plural(ing.totalEventsReceived, "event")}</span>
        {ing.lastEventAt && <span>last {timeAgo(ing.lastEventAt, now)}</span>}
      </div>
      {ing.error && (
        // One line until tapped: the full message is reachable without hover.
        <button
          type="button"
          className={`dl-events-ingestor-error ${showError ? "is-expanded" : ""}`}
          aria-expanded={showError}
          onClick={() => setShowError((v) => !v)}
        >
          {ing.error}
        </button>
      )}
    </article>
  );
}

function EventRow({
  ev,
  now,
  expanded,
  onToggle,
}: {
  ev: AdminEvent;
  now: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="dl-events-row-wrap">
      <button type="button" className="dl-events-row" aria-expanded={expanded} onClick={onToggle}>
        {expanded ? (
          <ChevronDown size={14} className="dl-events-chevron" aria-hidden="true" />
        ) : (
          <ChevronRight size={14} className="dl-events-chevron" aria-hidden="true" />
        )}
        <span className="badge badge-info dl-events-source mono">{ev.source}</span>
        {ev.instanceId && <span className="dl-events-instance mono">{ev.instanceId}</span>}
        <span className="dl-events-type mono">{ev.eventType}</span>
        <span className="dl-events-preview">{dataPreview(ev.data)}</span>
        <span className="dl-events-time" title={ev.receivedAt}>
          {timeAgo(ev.receivedAtMs, now)}
        </span>
      </button>
      {expanded && (
        <div className="dl-events-detail">
          <dl className="dl-events-detail-meta">
            {ev.instanceId && (
              <div>
                <dt>Instance</dt>
                <dd className="mono">{ev.instanceId}</dd>
              </div>
            )}
            <div>
              <dt>ID</dt>
              <dd className="mono">{ev.id}</dd>
            </div>
            <div>
              <dt>Idempotency key</dt>
              <dd className="mono">{ev.idempotencyKey}</dd>
            </div>
            <div>
              <dt>Received</dt>
              <dd className="mono" title={ev.receivedAt}>
                {new Date(ev.receivedAtMs).toLocaleString()}
              </dd>
            </div>
          </dl>
          <pre className="dl-events-json mono">{prettyData(ev.data)}</pre>
        </div>
      )}
    </div>
  );
}
