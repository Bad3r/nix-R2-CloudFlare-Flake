import type { JSX } from "preact";
import type { ObjectMetadata } from "../lib/api";
import { formatBytes, formatWhen, readEtag } from "../lib/format";
import { Badge, PanelHead } from "./primitives";

type ObjectTableProps = {
  folders: string[];
  objects: ObjectMetadata[];
  selectedKey: string | null;
  loading: boolean;
  error: string;
  onOpenFolder: (prefix: string) => void;
  onSelect: (key: string) => void;
  onActivate: (key: string) => void;
};

function activateOnKey(handler: () => void) {
  return (event: KeyboardEvent): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handler();
    }
  };
}

/** The object listing: the console's primary data surface. */
export function ObjectTable({
  folders,
  objects,
  selectedKey,
  loading,
  error,
  onOpenFolder,
  onSelect,
  onActivate,
}: ObjectTableProps): JSX.Element {
  const isEmpty = !loading && folders.length === 0 && objects.length === 0;

  return (
    <section class="panel reveal" style={{ "--i": 1 }}>
      <PanelHead
        index="04"
        title="Objects"
        actions={
          <Badge tone="neutral">
            {folders.length} pfx · {objects.length} obj
          </Badge>
        }
      />
      <div class="panel-body flush">
        {error ? <div class="alert" role="alert" style={{ margin: "0.7rem" }}>{error}</div> : null}
        <div class="table-wrap">
          <table class="objects">
            <thead>
              <tr>
                <th scope="col" style={{ width: "44%" }}>Key</th>
                <th scope="col">Size</th>
                <th scope="col">Uploaded</th>
                <th scope="col">ETag</th>
                <th scope="col" style={{ width: "6rem" }}>Kind</th>
              </tr>
            </thead>
            <tbody>
              {folders.map((folder) => (
                <tr
                  key={folder}
                  class="folder"
                  tabIndex={0}
                  role="button"
                  aria-label={`Open prefix ${folder}`}
                  onClick={() => onOpenFolder(folder)}
                  onKeyDown={activateOnKey(() => onOpenFolder(folder))}
                >
                  <td>
                    <span class="cell-key">
                      <span class="glyph" aria-hidden="true">▸</span>
                      <span class="truncate" title={folder}>{folder}</span>
                    </span>
                  </td>
                  <td class="dim">-</td>
                  <td class="dim">-</td>
                  <td class="dim">-</td>
                  <td><Badge tone="accent">prefix</Badge></td>
                </tr>
              ))}
              {objects.map((object) => {
                const selected = object.key === selectedKey;
                return (
                  <tr
                    key={object.key}
                    class={selected ? "selected" : ""}
                    tabIndex={0}
                    // aria-selected is ignored on a tr outside a grid role;
                    // aria-current is valid on any element and is what AT
                    // announces for "the current item in a set".
                    aria-current={selected ? "true" : undefined}
                    onClick={() => onSelect(object.key)}
                    onDblClick={() => onActivate(object.key)}
                    onKeyDown={(event) => {
                      // Stop propagation on handled keys: the row is not in
                      // useKeyboardNav's INTERACTIVE selector, so a bubbled
                      // Enter would trigger the global preview a second time.
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.stopPropagation();
                        onActivate(object.key);
                      } else if (event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        onSelect(object.key);
                      }
                    }}
                  >
                    <td>
                      <span class="cell-key">
                        <span class="glyph" aria-hidden="true">·</span>
                        <span class="truncate" title={object.key}>{object.key}</span>
                      </span>
                    </td>
                    <td class="num">{formatBytes(object.size)}</td>
                    <td class="num dim">{formatWhen(object.uploaded)}</td>
                    <td class="num dim truncate" title={object.etag}>{readEtag(object)}</td>
                    <td><Badge>object</Badge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {isEmpty ? <div class="empty" style={{ margin: "0.7rem" }}>No objects under this prefix.</div> : null}
        {loading ? <div class="tag" style={{ padding: "0.6rem 0.8rem" }}>Listing…</div> : null}
      </div>
    </section>
  );
}
