import type { JSX } from "preact";
import { PanelHead } from "./primitives";

const SHORTCUTS: Array<{ label: string; keys: string[] }> = [
  { label: "Focus prefix", keys: ["/"] },
  { label: "Move selection", keys: ["j", "k"] },
  { label: "Preview object", keys: ["Enter"] },
  { label: "Download object", keys: ["Shift", "D"] },
  { label: "Create share", keys: ["Shift", "R"] },
];

/** Static keyboard reference rendered with real <kbd> elements. */
export function ShortcutsPanel(): JSX.Element {
  return (
    <section class="panel reveal" style={{ "--i": 1 }}>
      <PanelHead index="02" title="Shortcuts" />
      <div class="panel-body">
        <div class="shortcuts">
          {SHORTCUTS.map((shortcut) => (
            <div class="shortcut" key={shortcut.label}>
              <span>{shortcut.label}</span>
              <span class="row" style={{ gap: "0.25rem" }}>
                {shortcut.keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
