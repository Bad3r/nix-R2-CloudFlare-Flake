import type { JSX } from "preact";
import type { ActivityItem } from "../hooks/useActivityLog";
import { formatRelative } from "../lib/format";
import { PanelHead } from "./primitives";

type ActivityLogProps = {
  activity: ActivityItem[];
  onClear: () => void;
};

/** Reverse-chronological activity feed with an aria-live region. */
export function ActivityLog({ activity, onClear }: ActivityLogProps): JSX.Element {
  return (
    <section class="panel reveal" style={{ "--i": 3 }}>
      <PanelHead
        index="06"
        title="Activity"
        actions={
          <button type="button" class="btn ghost tiny" onClick={onClear} disabled={activity.length === 0}>
            Clear
          </button>
        }
      />
      <div class="panel-body">
        {activity.length === 0 ? <div class="empty">Activity stream is empty.</div> : null}
        <div class="log" aria-live="polite" aria-label="Activity log">
          {activity.map((entry) => (
            <div class="log-line" key={entry.id}>
              <span class={`lvl ${entry.level}`} aria-hidden="true" />
              <span>{entry.message}</span>
              <time dateTime={entry.timestamp} title={entry.timestamp}>{formatRelative(entry.timestamp)}</time>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
