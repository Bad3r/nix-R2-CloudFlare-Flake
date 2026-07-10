import type { ComponentChildren, JSX } from "preact";

type BadgeTone = "neutral" | "ok" | "warn" | "danger" | "accent";

/** Compact uppercase status chip. */
export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ComponentChildren }): JSX.Element {
  const cls = tone === "neutral" ? "badge" : `badge ${tone}`;
  return <span class={cls}>{children}</span>;
}

/** Connection indicator dot: live (pulsing), off, or idle. */
export function StatusDot({ state }: { state: "live" | "off" | "idle" }): JSX.Element {
  const cls = state === "live" ? "dot live" : state === "off" ? "dot off" : "dot";
  return <span class={cls} aria-hidden="true" />;
}

/** Accessible determinate progress bar. */
export function ProgressBar({
  value,
  total,
  tone = "accent",
  label,
}: {
  value: number;
  total: number;
  tone?: "accent" | "done" | "err";
  /** Accessible name; role=progressbar is unnamed without it. */
  label: string;
}): JSX.Element {
  const ratio = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  const cls = tone === "accent" ? "progress" : `progress ${tone}`;
  return (
    <div
      class={cls}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total > 0 ? total : 1}
      aria-valuenow={value}
    >
      <span style={{ width: `${ratio}%` }} />
    </div>
  );
}

/** Section panel header with an index tag (e.g. "01 · SESSION"). */
export function PanelHead({
  index,
  title,
  actions,
}: {
  index: string;
  title: string;
  actions?: ComponentChildren;
}): JSX.Element {
  return (
    <div class="panel-head">
      <span class="tag">
        <span class="idx">{index}</span>
        {title}
      </span>
      {actions ? <div class="row">{actions}</div> : null}
    </div>
  );
}
