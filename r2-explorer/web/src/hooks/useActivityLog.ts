import { useCallback, useState } from "preact/hooks";

export type ActivityLevel = "info" | "success" | "error";

export type ActivityItem = {
  id: number;
  timestamp: string;
  message: string;
  level: ActivityLevel;
};

export type ActivityLog = {
  activity: ActivityItem[];
  append: (message: string, level?: ActivityLevel) => void;
  clear: () => void;
};

const MAX_ENTRIES = 150;
let sequence = 0;

/**
 * Append-only activity feed capped at {@link MAX_ENTRIES}. `append` is a stable
 * callback (functional updates only) so effects that depend on it do not re-fire
 * when the log changes.
 */
export function useActivityLog(): ActivityLog {
  const [activity, setActivity] = useState<ActivityItem[]>([]);

  const append = useCallback((message: string, level: ActivityLevel = "info") => {
    setActivity((current) => {
      sequence += 1;
      const entry: ActivityItem = {
        id: sequence,
        timestamp: new Date().toISOString(),
        message,
        level,
      };
      return [entry, ...current].slice(0, MAX_ENTRIES);
    });
  }, []);

  const clear = useCallback(() => setActivity([]), []);

  return { activity, append, clear };
}
