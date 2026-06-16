import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AdminCaller } from "drawlatch-admin-types";
import { api, isDaemonDown } from "../api";
import { useDaemon } from "../contexts/DaemonContext";

type FetchState =
  | { status: "loading" }
  | { status: "ok"; callers: AdminCaller[] }
  | { status: "error"; message: string };

const FINGERPRINT_PREVIEW_LEN = 12;

export default function CallerList() {
  const { daemon } = useDaemon();
  const navigate = useNavigate();
  const [state, setState] = useState<FetchState>({ status: "loading" });

  useEffect(() => {
    if (daemon !== "up") return;

    let cancelled = false;
    (async () => {
      const res = await api.callers();
      if (cancelled) return;
      if (isDaemonDown(res)) {
        setState({ status: "error", message: res.error });
        return;
      }
      setState({ status: "ok", callers: res });
    })();
    return () => {
      cancelled = true;
    };
  }, [daemon]);

  if (daemon === "down") {
    return (
      <>
        <header className="page-header">
          <h1 className="page-title">Callers</h1>
        </header>
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>
            Drawlatch daemon is not reachable. Start it with{" "}
            <code>drawlatch start</code> to load callers.
          </span>
        </div>
      </>
    );
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Callers</h1>
          <div className="page-subtitle">
            Registered callers from <code>remote.config.json</code>
          </div>
        </div>
        {state.status === "ok" && (
          <span className="page-subtitle">
            {state.callers.length} caller
            {state.callers.length === 1 ? "" : "s"}
          </span>
        )}
      </header>

      {state.status === "loading" && (
        <div className="banner banner-loading">Loading callers…</div>
      )}

      {state.status === "error" && (
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>Failed to load callers: {state.message}</span>
        </div>
      )}

      {state.status === "ok" && state.callers.length === 0 && (
        <div className="placeholder">
          <span className="placeholder-title">No callers registered</span>
          <span>
            Pair a callboard with <code>drawlatch sync</code> to add one.
          </span>
        </div>
      )}

      {state.status === "ok" && state.callers.length > 0 && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Alias</th>
                <th>Name</th>
                <th className="num">Connections</th>
                <th>Fingerprint</th>
                <th>Keys dir</th>
              </tr>
            </thead>
            <tbody>
              {state.callers.map((c) => (
                <tr
                  key={c.alias}
                  className="data-table-row-clickable"
                  onClick={() => navigate(`/callers/${c.alias}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate(`/callers/${c.alias}`);
                    }
                  }}
                  tabIndex={0}
                  role="link"
                >
                  <td>
                    <div className="cell-primary mono">{c.alias}</div>
                  </td>
                  <td>
                    {c.name ?? <span className="cell-muted">—</span>}
                  </td>
                  <td className="num">{c.connections.length}</td>
                  <td>
                    {c.fingerprint ? (
                      <span className="mono" title={c.fingerprint}>
                        {c.fingerprint.slice(0, FINGERPRINT_PREVIEW_LEN)}
                        {c.fingerprint.length > FINGERPRINT_PREVIEW_LEN ? "…" : ""}
                      </span>
                    ) : (
                      <span className="cell-muted">—</span>
                    )}
                  </td>
                  <td>
                    <KeysDirBadge exists={c.keysDirExists} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function KeysDirBadge({ exists }: { exists: boolean }) {
  return (
    <span
      className={`keys-dir-badge keys-dir-${exists ? "ok" : "missing"}`}
    >
      {exists ? "ok" : "missing"}
    </span>
  );
}
