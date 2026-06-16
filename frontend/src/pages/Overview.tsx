import { useEffect, useState } from "react";
import { useDaemon } from "../contexts/DaemonContext";
import { api, isDaemonDown } from "../api";
import { formatUptime } from "../utils/format";
import type { AdminHealth } from "drawlatch-admin-types";

interface SecretStats {
  total: number;
  configured: number;
}

export default function Overview() {
  const { daemon, meta, tick } = useDaemon();
  const [health, setHealth] = useState<AdminHealth | null>(null);
  const [secrets, setSecrets] = useState<SecretStats | null>(null);

  useEffect(() => {
    if (daemon !== "up") return;
    let cancelled = false;
    (async () => {
      const [healthRes, secretsRes] = await Promise.all([
        api.health(),
        api.secrets(),
      ]);
      if (cancelled) return;
      if (!isDaemonDown(healthRes)) setHealth(healthRes);
      if (!isDaemonDown(secretsRes)) {
        const total = secretsRes.length;
        const configured = secretsRes.filter((s) => s.present).length;
        setSecrets({ total, configured });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [daemon, tick]);

  if (daemon === "unknown") {
    return (
      <>
        <header className="page-header">
          <h1 className="page-title">Overview</h1>
        </header>
        <div className="banner banner-loading">Connecting to daemon…</div>
      </>
    );
  }

  if (daemon === "down") {
    return (
      <>
        <header className="page-header">
          <h1 className="page-title">Overview</h1>
        </header>
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>
            Drawlatch daemon is not reachable on its loopback admin port.
            Start it with <code>drawlatch start</code> and this view will
            recover automatically.
          </span>
        </div>
      </>
    );
  }

  const counts = health?.ingestorCounts;
  const ingestorTotal = counts
    ? counts.connected + counts.error + counts.starting + counts.stopped
    : 0;

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Overview</h1>
          <div className="page-subtitle">
            {meta?.configPath ?? ""}
          </div>
        </div>
      </header>

      <section className="card-grid">
        <div className="card">
          <span className="card-label">Status</span>
          <span className="card-value" style={{ color: "var(--success)" }}>
            running
          </span>
          <span className="card-sub">pid {meta?.pid ?? "—"}</span>
        </div>

        <div className="card">
          <span className="card-label">Port</span>
          <span className="card-value card-value-mono">{meta?.port ?? "—"}</span>
          <span className="card-sub">loopback only</span>
        </div>

        <div className="card">
          <span className="card-label">Uptime</span>
          <span className="card-value">
            {health ? formatUptime(health.uptimeSec) : "—"}
          </span>
          {meta?.startedAt && (
            <span className="card-sub">
              since {new Date(meta.startedAt).toLocaleString()}
            </span>
          )}
        </div>

        <div className="card">
          <span className="card-label">Version</span>
          <span className="card-value card-value-mono">
            {meta?.version ?? "—"}
          </span>
        </div>

        <div className="card">
          <span className="card-label">Active Sessions</span>
          <span className="card-value">{health?.activeSessions ?? "—"}</span>
        </div>

        <div className="card span-2">
          <span className="card-label">Ingestors ({ingestorTotal})</span>
          <div className="ingestor-breakdown">
            <span className="ingestor-stat ingestor-stat-connected">
              <span className="status-dot" aria-hidden="true" />
              {counts?.connected ?? 0} connected
            </span>
            <span className="ingestor-stat ingestor-stat-starting">
              <span className="status-dot" aria-hidden="true" />
              {counts?.starting ?? 0} starting
            </span>
            <span className="ingestor-stat ingestor-stat-error">
              <span className="status-dot" aria-hidden="true" />
              {counts?.error ?? 0} error
            </span>
            <span className="ingestor-stat ingestor-stat-stopped">
              <span className="status-dot" aria-hidden="true" />
              {counts?.stopped ?? 0} stopped
            </span>
          </div>
        </div>

        <div className="card">
          <span className="card-label">Secrets</span>
          <span className="card-value">
            {secrets
              ? `${secrets.configured} of ${secrets.total}`
              : "—"}
          </span>
          <span className="card-sub">configured</span>
        </div>
      </section>
    </>
  );
}
