import type { JSX } from "preact";
import type { SessionInfoResponse } from "../lib/api";
import { Badge, PanelHead } from "./primitives";

type SessionPanelProps = {
  session: SessionInfoResponse | null;
  authRequired: boolean;
  fatalError: string;
  onSignIn: () => void;
  onSignOut: () => void;
};

/** Identity summary plus the sign-in / sign-out control. */
export function SessionPanel({ session, authRequired, fatalError, onSignIn, onSignOut }: SessionPanelProps): JSX.Element {
  const upload = session?.limits.upload;
  return (
    <section class="panel reveal" style={{ "--i": 0 }}>
      <PanelHead index="01" title="Session" />
      <div class="panel-body stack">
        <div class="kv">
          <div class="line">
            <span class="k">Mode</span>
            <span class="v">
              <Badge tone={session?.readonly ? "warn" : "ok"}>{session?.readonly ? "read-only" : "read-write"}</Badge>
            </span>
          </div>
          <div class="line">
            <span class="k">Max upload</span>
            <span class="v num">{upload ? `${Math.floor(upload.maxFileBytes / 1024 ** 3)} GiB` : "-"}</span>
          </div>
          <div class="line">
            <span class="k">Part size</span>
            <span class="v num">{upload ? `${Math.floor(upload.partSizeBytes / 1024 ** 2)} MiB` : "-"}</span>
          </div>
          <div class="line">
            <span class="k">Buckets</span>
            <span class="v num">{session?.buckets.length ?? 0}</span>
          </div>
        </div>

        {authRequired ? (
          <button type="button" class="btn primary" onClick={onSignIn}>
            Sign in with Access
          </button>
        ) : (
          <button type="button" class="btn ghost" onClick={onSignOut} disabled={!session}>
            Sign out
          </button>
        )}

        {fatalError ? <div class="alert" role="alert">{fatalError}</div> : null}
      </div>
    </section>
  );
}
