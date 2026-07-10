import type { JSX } from "preact";
import type { SessionInfoResponse } from "../lib/api";
import { Badge, StatusDot } from "./primitives";
import { ThemeToggle } from "./ThemeToggle";

type StatusBarProps = {
  session: SessionInfoResponse | null;
  authRequired: boolean;
  ready: boolean;
};

/** Instrument bezel: brand, connection state, worker identity, theme toggle. */
export function StatusBar({ session, authRequired, ready }: StatusBarProps): JSX.Element {
  const connection: "live" | "off" | "idle" = !ready ? "idle" : session ? "live" : "off";
  const connectionLabel = !ready ? "Connecting" : session ? "Online" : authRequired ? "Sign in" : "Offline";

  return (
    <header class="statusbar">
      <div class="brand">
        <span class="mark" aria-hidden="true">R2</span>
        <span>Explorer</span>
      </div>
      <div class="row" style={{ gap: "0.5rem" }}>
        <StatusDot state={connection} />
        <span class="tag" aria-live="polite">{connectionLabel}</span>
        {session ? (
          <Badge tone={session.readonly ? "warn" : "ok"}>{session.readonly ? "read-only" : "read-write"}</Badge>
        ) : null}
      </div>

      <div class="meta">
        <div class="stat">
          <span class="k">Worker</span>
          <span class="v num truncate">{session?.version ?? "-"}</span>
        </div>
        <div class="stat">
          <span class="k">Actor</span>
          <span class="v truncate" title={session?.actor.actor ?? ""}>{session?.actor.actor ?? "-"}</span>
        </div>
        <div class="stat">
          <span class="k">Auth</span>
          <span class="v">{session?.actor.mode ?? "unknown"}</span>
        </div>
        <ThemeToggle />
      </div>
    </header>
  );
}
