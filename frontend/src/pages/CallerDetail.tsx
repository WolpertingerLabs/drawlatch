import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type {
  AdminCaller,
  AdminCallerConnection,
  AdminSecretRef,
} from "drawlatch-admin-types";
import { api, isDaemonDown } from "../api";
import { useDaemon } from "../contexts/DaemonContext";
import { KeysDirBadge } from "./CallerList";

type FetchState =
  | { status: "loading" }
  | { status: "not-found" }
  | {
      status: "ok";
      caller: AdminCaller;
      connections: AdminCallerConnection[];
    }
  | { status: "error"; message: string };

export default function CallerDetail() {
  const { alias } = useParams<{ alias: string }>();
  const { daemon } = useDaemon();
  const [state, setState] = useState<FetchState>({ status: "loading" });

  useEffect(() => {
    if (!alias) return;
    if (daemon !== "up") return;

    let cancelled = false;
    (async () => {
      const callersRes = await api.callers();
      if (cancelled) return;
      if (isDaemonDown(callersRes)) {
        setState({ status: "error", message: callersRes.error });
        return;
      }
      const caller = callersRes.find((c) => c.alias === alias);
      if (!caller) {
        setState({ status: "not-found" });
        return;
      }
      const connsRes = await api.callerConnections(alias);
      if (cancelled) return;
      if (isDaemonDown(connsRes)) {
        setState({ status: "error", message: connsRes.error });
        return;
      }
      setState({ status: "ok", caller, connections: connsRes });
    })();
    return () => {
      cancelled = true;
    };
  }, [alias, daemon]);

  if (daemon === "down") {
    return (
      <>
        <BackLink />
        <header className="page-header">
          <h1 className="page-title">{alias}</h1>
        </header>
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>
            Drawlatch daemon is not reachable. Start it with{" "}
            <code>drawlatch start</code>.
          </span>
        </div>
      </>
    );
  }

  if (state.status === "loading") {
    return (
      <>
        <BackLink />
        <div className="banner banner-loading">Loading…</div>
      </>
    );
  }

  if (state.status === "error") {
    return (
      <>
        <BackLink />
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>Failed to load caller: {state.message}</span>
        </div>
      </>
    );
  }

  if (state.status === "not-found") {
    return (
      <>
        <BackLink />
        <header className="page-header">
          <h1 className="page-title">Not found</h1>
        </header>
        <div className="placeholder">
          <span className="placeholder-title">
            No caller named &quot;{alias}&quot;
          </span>
          <span>
            Return to the <Link to="/callers">caller list</Link>.
          </span>
        </div>
      </>
    );
  }

  const { caller, connections } = state;

  return (
    <>
      <BackLink />
      <header className="page-header">
        <div>
          <div className="title-row">
            <h1 className="page-title">{caller.name ?? caller.alias}</h1>
            <KeysDirBadge exists={caller.keysDirExists} />
          </div>
          <div className="subtitle-meta">
            <span className="mono">{caller.alias}</span>
            {caller.fingerprint && (
              <>
                <span className="dot-sep">·</span>
                <span className="mono" title="Ed25519 public key fingerprint">
                  {caller.fingerprint}
                </span>
              </>
            )}
          </div>
        </div>
      </header>

      <section className="detail-section">
        <h2 className="section-title">
          Connections ({connections.length})
        </h2>
        {connections.length === 0 ? (
          <p className="detail-note">
            This caller has no connections enabled.
          </p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Connection</th>
                  <th>Status</th>
                  <th>Required secrets</th>
                  <th>Optional secrets</th>
                  <th>Ingestor</th>
                  <th className="num">Instances</th>
                </tr>
              </thead>
              <tbody>
                {connections.map((c) => (
                  <tr key={c.connectionAlias}>
                    <td>
                      <div className="cell-primary mono">
                        {c.connectionAlias}
                      </div>
                    </td>
                    <td>
                      <div className="badge-row">
                        <EnabledBadge enabled={c.enabled} />
                        {c.isCustom && (
                          <span className="tag tag-custom">custom</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <SecretRefList
                        secrets={c.requiredSecrets}
                        emptyText="—"
                      />
                    </td>
                    <td>
                      <SecretRefList
                        secrets={c.optionalSecrets}
                        emptyText="—"
                      />
                    </td>
                    <td>
                      {c.hasIngestor ? (
                        <span className="tag">yes</span>
                      ) : (
                        <span className="cell-muted">—</span>
                      )}
                    </td>
                    <td className="num">{c.instances.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function BackLink() {
  return (
    <Link to="/callers" className="back-link">
      ← Back to callers
    </Link>
  );
}

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`enabled-badge enabled-${enabled ? "yes" : "no"}`}
    >
      {enabled ? "enabled" : "disabled"}
    </span>
  );
}

function SecretRefList({
  secrets,
  emptyText,
}: {
  secrets: AdminSecretRef[];
  emptyText: string;
}) {
  if (secrets.length === 0) {
    return <span className="cell-muted">{emptyText}</span>;
  }
  return (
    <ul className="secret-ref-list">
      {secrets.map((s) => (
        <li
          key={s.name}
          className={`secret-ref-pill mono secret-ref-${s.present ? "present" : "missing"}`}
        >
          <span className="secret-ref-mark" aria-hidden="true">
            {s.present ? "✓" : "✗"}
          </span>
          <span>{s.name}</span>
        </li>
      ))}
    </ul>
  );
}
