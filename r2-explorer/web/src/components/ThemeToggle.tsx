import { useCallback, useState } from "preact/hooks";
import type { JSX } from "preact";
import { readTheme, type Theme } from "../lib/theme";

/**
 * Toggles the document theme and persists the choice. The initial theme is
 * set pre-paint by an inline script in ConsoleLayout, and this island hydrates
 * with client:load, so the lazy initializer reads the already-correct DOM
 * value at hydration time instead of assuming "dark" and correcting a frame
 * later (which flashed the wrong icon/label and could no-op a click made
 * during that window).
 */
export function ThemeToggle(): JSX.Element {
  const [theme, setTheme] = useState<Theme>(() => readTheme());

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
