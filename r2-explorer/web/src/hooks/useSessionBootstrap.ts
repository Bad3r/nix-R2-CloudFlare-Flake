import { useCallback, useEffect, useState } from "preact/hooks";
import { fetchSessionInfo, isAbortError, type SessionInfoResponse } from "../lib/api";
import { errorMessage, isAuthRequired } from "../lib/format";
import type { ActivityLog } from "./useActivityLog";

export type SessionState = {
  session: SessionInfoResponse | null;
  authRequired: boolean;
  fatalError: string;
  ready: boolean;
  setAuthRequired: (value: boolean) => void;
  setFatalError: (value: string) => void;
  reload: () => void;
};

/**
 * Loads worker session info exactly once on mount. Kept independent of the
 * object-list callbacks so a change in list state never re-triggers session
 * fetching (the previous coupling re-ran bootstrap on every keystroke).
 */
export function useSessionBootstrap(log: Pick<ActivityLog, "append">): SessionState {
  const { append } = log;
  const [session, setSession] = useState<SessionInfoResponse | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [fatalError, setFatalError] = useState("");
  const [ready, setReady] = useState(false);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setReady(false);

    void (async () => {
      try {
        const payload = await fetchSessionInfo(controller.signal);
        setSession(payload);
        setAuthRequired(false);
        setFatalError("");
        append(`Connected to worker ${payload.version}`, "success");
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
        if (isAuthRequired(error)) {
          setSession(null);
          setAuthRequired(true);
          setFatalError("Sign in required. Use Cloudflare Access to continue.");
          append("Authentication required. Sign in to start a session.", "error");
        } else {
          const message = errorMessage(error);
          setFatalError(message);
          append(`Failed to load session: ${message}`, "error");
        }
      } finally {
        setReady(true);
      }
    })();

    return () => controller.abort();
  }, [append, nonce]);

  return { session, authRequired, fatalError, ready, setAuthRequired, setFatalError, reload };
}
