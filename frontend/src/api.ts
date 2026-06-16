import type {
  AdminCaller,
  AdminCallerConnection,
  AdminConnectionTemplate,
  AdminHealth,
  AdminIngestor,
  AdminMeta,
  AdminSecret,
  AdminSession,
  DaemonOfflineEnvelope,
} from "drawlatch-admin-types";
import { notifyAuthRequired } from "./auth";

export type DaemonResponse<T> = T | DaemonOfflineEnvelope;

export function isDaemonDown<T>(
  body: DaemonResponse<T>,
): body is DaemonOfflineEnvelope {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as DaemonOfflineEnvelope).daemon === "down"
  );
}

async function getJson<T>(path: string): Promise<DaemonResponse<T>> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  if (res.status === 401) {
    // Session expired (or missing) — boot the user back to Login.
    notifyAuthRequired();
    return { daemon: "down", error: "Not authenticated" };
  }
  if (!res.ok) {
    return { daemon: "down", error: `HTTP ${res.status}` };
  }
  return (await res.json()) as DaemonResponse<T>;
}

export const api = {
  meta: () => getJson<AdminMeta>("/api/admin/meta"),
  health: () => getJson<AdminHealth>("/api/admin/health"),
  secrets: () => getJson<AdminSecret[]>("/api/admin/secrets"),
  connections: () =>
    getJson<AdminConnectionTemplate[]>("/api/admin/connections"),
  callers: () => getJson<AdminCaller[]>("/api/admin/callers"),
  callerConnections: (alias: string) =>
    getJson<AdminCallerConnection[]>(
      `/api/admin/callers/${encodeURIComponent(alias)}/connections`,
    ),
  ingestors: () => getJson<AdminIngestor[]>("/api/admin/ingestors"),
  sessions: () => getJson<AdminSession[]>("/api/admin/sessions"),
};
