import { useEffect } from "preact/hooks";
import type { RefObject } from "preact";

export type KeyboardActions = {
  focusPrefix: () => void;
  moveDown: () => void;
  moveUp: () => void;
  preview: () => void;
  download: () => void;
  createShare: () => void;
  hasSelection: boolean;
};

const INTERACTIVE = "input, textarea, select, button, a, [contenteditable], [role='button']";

/**
 * Global keyboard shortcuts for the object browser.
 *
 * Shortcuts are suppressed when focus is on an interactive or editable element,
 * so Enter/Space keep activating the focused button or link natively (the prior
 * implementation hijacked Enter everywhere, making Delete/Revoke unreachable by
 * keyboard).
 */
export function useKeyboardNav(actions: KeyboardActions, prefixInput: RefObject<HTMLInputElement>): void {
  const { focusPrefix, moveDown, moveUp, preview, download, createShare, hasSelection } = actions;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && target.closest(INTERACTIVE)) {
        return;
      }

      switch (true) {
        case event.key === "/":
          event.preventDefault();
          focusPrefix();
          prefixInput.current?.focus();
          return;
        case event.key === "j":
          event.preventDefault();
          moveDown();
          return;
        case event.key === "k":
          event.preventDefault();
          moveUp();
          return;
        case event.key === "Enter" && hasSelection:
          event.preventDefault();
          preview();
          return;
        case event.shiftKey && event.key.toLowerCase() === "d" && hasSelection:
          event.preventDefault();
          download();
          return;
        case event.shiftKey && event.key.toLowerCase() === "p" && hasSelection:
          event.preventDefault();
          preview();
          return;
        case event.shiftKey && event.key.toLowerCase() === "r" && hasSelection:
          event.preventDefault();
          createShare();
          return;
        default:
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [createShare, download, focusPrefix, hasSelection, moveDown, moveUp, preview, prefixInput]);
}
