export type Theme = "dark" | "light";

/** "dark" during SSR (no document); otherwise the DOM's current data-theme. */
export function readTheme(): Theme {
  if (typeof document === "undefined") {
    return "dark";
  }
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}
