import { useState } from "preact/hooks";
import type { JSX } from "preact";
import type { UploadItem } from "../hooks/useUploadQueue";
import { Badge, PanelHead, ProgressBar } from "./primitives";

type UploadPanelProps = {
  uploads: UploadItem[];
  prefix: string;
  onEnqueue: (file: File) => void;
  onCancel: (id: number) => void;
  onClearFinished: () => void;
};

function statusTone(status: UploadItem["status"]): "ok" | "danger" | "warn" | "neutral" {
  if (status === "done") {
    return "ok";
  }
  if (status === "error") {
    return "danger";
  }
  if (status === "cancelled") {
    return "neutral";
  }
  return "warn";
}

/** Drag-and-drop upload queue targeting the current prefix. */
export function UploadPanel({ uploads, prefix, onEnqueue, onCancel, onClearFinished }: UploadPanelProps): JSX.Element {
  const [dragging, setDragging] = useState(false);

  const handleFiles = (files: FileList | null | undefined): void => {
    if (!files) {
      return;
    }
    for (const file of Array.from(files)) {
      onEnqueue(file);
    }
  };

  return (
    <section class="panel reveal" style={{ "--i": 2 }}>
      <PanelHead
        index="03"
        title="Uploads"
        actions={
          <button type="button" class="btn ghost tiny" onClick={onClearFinished}>
            Clear finished
          </button>
        }
      />
      <div class="panel-body stack">
        <label
          class={dragging ? "dropzone drag" : "dropzone"}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            handleFiles(event.dataTransfer?.files);
          }}
        >
          <input
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(event) => {
              handleFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
          <div class="tag">Drop files or click to browse</div>
          <div class="faint" style={{ fontSize: "0.74rem", marginTop: "0.3rem" }}>
            target prefix <span class="mono">{prefix || "/"}</span>
          </div>
        </label>

        {uploads.length === 0 ? <div class="empty">No uploads this session.</div> : null}

        {uploads.map((item) => (
          <div class="upload" key={item.id}>
            <div class="spread">
              <span class="mono truncate" style={{ fontSize: "0.8rem" }}>{item.fileName}</span>
              <Badge tone={statusTone(item.status)}>{item.status}</Badge>
            </div>
            <ProgressBar
              value={item.uploadedParts}
              total={item.totalParts}
              tone={item.status === "error" ? "err" : item.status === "done" ? "done" : "accent"}
            />
            <div class="spread">
              <span class="faint" style={{ fontSize: "0.74rem" }}>{item.detail}</span>
              <span class="faint num" style={{ fontSize: "0.72rem" }}>
                {item.uploadedParts}/{item.totalParts || "-"} parts
              </span>
            </div>
            {item.status === "uploading" ? (
              <button type="button" class="btn ghost tiny" onClick={() => onCancel(item.id)}>
                Cancel
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
