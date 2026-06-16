import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AdminConnectionTemplate } from "drawlatch-admin-types";
import { api, isDaemonDown } from "../api";
import { useDaemon } from "../contexts/DaemonContext";

type FetchState =
  | { status: "loading" }
  | { status: "ok"; templates: AdminConnectionTemplate[] }
  | { status: "error"; message: string };

export default function ConnectionList() {
  const { daemon } = useDaemon();
  const navigate = useNavigate();
  const [state, setState] = useState<FetchState>({ status: "loading" });

  useEffect(() => {
    if (daemon !== "up") return;

    let cancelled = false;
    (async () => {
      const res = await api.connections();
      if (cancelled) return;
      if (isDaemonDown(res)) {
        setState({ status: "error", message: res.error });
        return;
      }
      setState({ status: "ok", templates: res });
    })();
    return () => {
      cancelled = true;
    };
  }, [daemon]);

  if (daemon === "down") {
    return (
      <>
        <header className="page-header">
          <h1 className="page-title">Connections</h1>
        </header>
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>
            Drawlatch daemon is not reachable. Start it with{" "}
            <code>drawlatch start</code> to load connection templates.
          </span>
        </div>
      </>
    );
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Connections</h1>
          <div className="page-subtitle">
            Built-in API connection templates
          </div>
        </div>
        {state.status === "ok" && (
          <span className="page-subtitle">
            {state.templates.length} template
            {state.templates.length === 1 ? "" : "s"}
          </span>
        )}
      </header>

      {state.status === "loading" && (
        <div className="banner banner-loading">Loading connections…</div>
      )}

      {state.status === "error" && (
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>Failed to load connections: {state.message}</span>
        </div>
      )}

      {state.status === "ok" && state.templates.length === 0 && (
        <div className="placeholder">
          <span className="placeholder-title">No connection templates</span>
          <span>The daemon returned an empty list.</span>
        </div>
      )}

      {state.status === "ok" && state.templates.length > 0 && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th>Stability</th>
                <th>Ingestor</th>
                <th className="num">Required secrets</th>
              </tr>
            </thead>
            <tbody>
              {state.templates.map((t) => (
                <tr
                  key={t.alias}
                  className="data-table-row-clickable"
                  onClick={() => navigate(`/connections/${t.alias}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate(`/connections/${t.alias}`);
                    }
                  }}
                  tabIndex={0}
                  role="link"
                >
                  <td>
                    <div className="cell-primary">{t.name}</div>
                    <div className="cell-secondary mono">{t.alias}</div>
                  </td>
                  <td>
                    <span className="tag">{t.category}</span>
                  </td>
                  <td>
                    <StabilityBadge stability={t.stability} />
                  </td>
                  <td>
                    {t.hasIngestor ? (
                      <span className="mono">{t.ingestorType ?? "?"}</span>
                    ) : (
                      <span className="cell-muted">—</span>
                    )}
                  </td>
                  <td className="num">{t.requiredSecrets.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function StabilityBadge({
  stability,
}: {
  stability: AdminConnectionTemplate["stability"];
}) {
  return (
    <span className={`stability-badge stability-${stability}`}>
      {stability}
    </span>
  );
}
