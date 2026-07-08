import { useCallback, useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";

type Theme = "dark" | "light";

function readTheme(): Theme {
  if (typeof document === "undefined") {
    return "dark";
  }
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/**
 * Toggles the document theme and persists the choice. The initial theme is set
 * pre-paint by an inline script in ConsoleLayout, so this only reflects and
 * mutates that state.
 */
export function ThemeToggle(): JSX.Element {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    setTheme(readTheme());
  }, []);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem("r2x-theme", next);
      } catch {
        /* storage unavailable (private mode); theme still applies for the session */
      }
      return next;
    });
  }, []);

  return (
    <button
      type="button"
      class="iconbtn"
      onClick={toggle}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
    >
      {theme === "dark" ? "◐" : "◑"}
    </button>
  );
}
