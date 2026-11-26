import { useCallback, useEffect, useRef, useState } from "react";
import { Route, Routes, useNavigate } from "react-router-dom";
import DashboardLayout from "./components/DashboardLayout";
import { DaemonProvider } from "./contexts/DaemonContext";
import Overview from "./pages/Overview";
import ConnectionsPage from "./pages/ConnectionsPage";
import ConnectionDetail from "./pages/ConnectionDetail";
import EventsView from "./pages/EventsView";
import CallerList from "./pages/CallerList";
import CallerDetail from "./pages/CallerDetail";
import IngestorTable from "./pages/IngestorTable";
import SessionTable from "./pages/SessionTable";
import SecretMatrix from "./pages/SecretMatrix";
import VaultPage from "./pages/VaultPage";
import ChangePassword from "./pages/ChangePassword";
import ComingSoon from "./pages/ComingSoon";
import Login from "./pages/Login";
import { checkAuth, onAuthRequired } from "./auth";

/** Why the first auth check couldn't decide, shown on the splash. */
interface PendingCheck {
  message: string;
  retryAfter: number;
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [serverError, setServerError] = useState<string>("");
  const [pending, setPending] = useState<PendingCheck | null>(null);
  const retryTimer = useRef<number | null>(null);
  const navigate = useNavigate();

  const runCheck = useCallback(() => {
    if (retryTimer.current !== null) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    void checkAuth().then((result) => {
      if (result.authenticated === null) {
        // Rate limited or unreachable: keep the current screen (a signed-in
        // user stays signed in) and try again later.
        const retryAfter = result.retryAfter ?? 10;
        setPending({ message: result.error ?? "", retryAfter });
        retryTimer.current = window.setTimeout(runCheck, retryAfter * 1000);
        return;
      }
      setPending(null);
      setAuthed(result.authenticated);
      setServerError(result.error ?? "");
    });
  }, []);

  useEffect(() => {
    runCheck();
    return () => {
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    };
  }, [runCheck]);

  // Mid-session 401 from any admin call -> boot back to Login.
  useEffect(() => {
    return onAuthRequired(() => {
      setAuthed(false);
      navigate("/", { replace: true });
    });
  }, [navigate]);

  if (authed === null) {
    return (
      <div className="auth-splash" role="status">
        {pending ? (
          <div className="auth-splash-pending">
            <span>{pending.message}</span>
            <span>Checking again in {pending.retryAfter}s.</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={runCheck}>
              Try now
            </button>
          </div>
        ) : (
          <>
            <span className="spinner" aria-hidden="true" />
            <span>Loading…</span>
          </>
        )}
      </div>
    );
  }

  if (!authed) {
    return (
      <Login
        // The login call itself proves the password and sets the cookie, so
        // there's no need to spend another rate-limited auth check on it.
        onLogin={() => {
          setServerError("");
          setAuthed(true);
        }}
        serverError={serverError || undefined}
      />
    );
  }

  return (
    <DaemonProvider>
        <Routes>
          <Route element={<DashboardLayout onLogout={() => setAuthed(false)} />}>
            <Route index element={<Overview />} />
            <Route path="connections" element={<ConnectionsPage />} />
            <Route path="connections/:alias" element={<ConnectionDetail />} />
            <Route path="callers" element={<CallerList />} />
            <Route path="callers/:alias" element={<CallerDetail />} />
            <Route path="ingestors" element={<IngestorTable />} />
            <Route path="sessions" element={<SessionTable />} />
            <Route path="secrets" element={<SecretMatrix />} />
            <Route path="vault" element={<VaultPage />} />
            <Route path="logs" element={<EventsView />} />
            <Route path="settings/password" element={<ChangePassword />} />
            <Route path="*" element={<ComingSoon title="Not found" />} />
          </Route>
        </Routes>
    </DaemonProvider>
  );
}
