import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { isAbortError } from "../lib/api";
import { errorMessage, isObjectExistsError, objectExistsKey } from "../lib/format";
import { isCancelledDuringPromotion, multipartUpload, type UploadProgress } from "../lib/upload";
import type { ActivityLog } from "./useActivityLog";

export type UploadStatus = "uploading" | "done" | "error" | "cancelled" | "conflict";

export type UploadItem = {
  id: number;
  fileName: string;
  status: UploadStatus;
  detail: string;
  uploadedParts: number;
  totalParts: number;
  originPrefix: string;
};

export type UploadQueue = {
  uploads: UploadItem[];
  enqueue: (file: File) => void;
  cancel: (id: number) => void;
  /** Retry a "conflict" item with overwrite: true (the server keeps a copy of the existing object in .trash/). */
  retryOverwrite: (id: number) => void;
  /** Abandon a "conflict" item without writing anything. */
  skip: (id: number) => void;
  clearFinished: () => void;
};

type UploadArgs = {
  log: Pick<ActivityLog, "append">;
  getCurrentPrefix: () => string;
  onUploaded: () => void;
};

let uploadSequence = 0;

/** Max simultaneously-active file uploads; further drops wait in the queue. */
const MAX_ACTIVE_UPLOADS = 2;

export type UploadSlotGate = {
  acquire: () => Promise<void>;
  release: () => void;
};

/**
 * Hand-off semaphore bounding simultaneously-active file uploads. Each file
 * still transfers its parts with the engine's own per-file concurrency; this
 * gate stops a large drop from opening dozens of upload sessions at once,
 * which the worker rejects with 429 past R2E_UPLOAD_MAX_CONCURRENT_PER_USER.
 */
export function createUploadSlotGate(maxActive: number): UploadSlotGate {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    acquire: () => {
      if (active < maxActive) {
        active += 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    release: () => {
      const next = waiters.shift();
      if (next) {
        // Hand the slot to the next waiter; the active count is unchanged.
        next();
        return;
      }
      active = Math.max(0, active - 1);
    },
  };
}

/**
 * Session-scoped multipart upload queue. Each upload records the prefix it was
 * queued against; on completion the object list is refreshed only when the user
 * is still viewing that prefix, so a long upload cannot replace a navigated-away
 * listing. Uploads are cancellable via AbortController.
 */
export function useUploadQueue({ log, getCurrentPrefix, onUploaded }: UploadArgs): UploadQueue {
  const { append } = log;
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const controllers = useRef(new Map<number, AbortController>());
  const slotGate = useRef(createUploadSlotGate(MAX_ACTIVE_UPLOADS));
  // File + origin prefix kept per id so a "conflict" item can be retried with
  // overwrite: true without asking the operator to re-pick the file.
  const pending = useRef(new Map<number, { file: File; originPrefix: string }>());

  const patch = useCallback((id: number, updater: (item: UploadItem) => UploadItem) => {
    setUploads((current) => current.map((item) => (item.id === id ? updater(item) : item)));
  }, []);

  // Warn before an unload that would silently abandon an in-flight transfer;
  // the worker's session and any created R2 multipart upload are otherwise
  // orphaned until R2E_UPLOAD_SESSION_TTL_SEC expires.
  const hasActiveUpload = uploads.some((item) => item.status === "uploading");
  useEffect(() => {
    if (!hasActiveUpload) {
      return;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasActiveUpload]);

  const runUpload = useCallback(
    (id: number, file: File, originPrefix: string, overwrite: boolean) => {
      const controller = new AbortController();
      controllers.current.set(id, controller);
      // Set once init succeeds; distinguishes an init-time conflict (offer
      // overwrite/skip) from the rare upload/complete race after parts have
      // already transferred (just an error: redoing the upload is the retry).
      let reachedUploadPhase = false;

      void (async () => {
        await slotGate.current.acquire();
        try {
          if (controller.signal.aborted) {
            patch(id, (item) => ({ ...item, status: "cancelled", detail: "Cancelled" }));
            append(`Upload cancelled for ${file.name}`, "info");
            return;
          }
          patch(id, (item) => ({ ...item, status: "uploading", detail: "Initializing" }));
          const completed = await multipartUpload(file, originPrefix, {
            signal: controller.signal,
            overwrite,
            onProgress: (progress: UploadProgress) => {
              reachedUploadPhase = true;
              patch(id, (item) => ({
                ...item,
                status: "uploading",
                detail: progress.phase === "finalizing" ? "Finalizing on server" : `Phase ${progress.phase}`,
                uploadedParts: progress.uploadedParts,
                totalParts: progress.totalParts,
              }));
            },
          });
          pending.current.delete(id);
          patch(id, (item) => ({
            ...item,
            status: "done",
            detail: `Stored as ${completed.key}`,
            uploadedParts: Math.max(item.uploadedParts, item.totalParts),
          }));
          append(`Uploaded ${file.name} to ${completed.key}`, "success");
          if (getCurrentPrefix() === originPrefix) {
            onUploaded();
          }
        } catch (error) {
          if (isCancelledDuringPromotion(error)) {
            pending.current.delete(id);
            patch(id, (item) => ({
              ...item,
              status: "cancelled",
              detail: "Cancelled locally; the server may still finish this upload",
            }));
            append(
              `Upload cancelled for ${file.name} while the server was finalizing it; check the listing before uploading it again`,
              "info",
            );
            return;
          }
          if (isAbortError(error)) {
            pending.current.delete(id);
            patch(id, (item) => ({ ...item, status: "cancelled", detail: "Cancelled" }));
            append(`Upload cancelled for ${file.name}`, "info");
            return;
          }
          if (isObjectExistsError(error)) {
            const key = objectExistsKey(error) ?? file.name;
            if (reachedUploadPhase) {
              pending.current.delete(id);
              patch(id, (item) => ({ ...item, status: "error", detail: `Already exists at ${key}` }));
              append(`Upload failed for ${file.name}: an object already exists at ${key}`, "error");
            } else {
              patch(id, (item) => ({ ...item, status: "conflict", detail: `Already exists at ${key}` }));
              append(`Upload needs confirmation: an object already exists at ${key}`, "info");
            }
            return;
          }
          pending.current.delete(id);
          const message = errorMessage(error);
          patch(id, (item) => ({ ...item, status: "error", detail: message }));
          append(`Upload failed for ${file.name}: ${message}`, "error");
        } finally {
          controllers.current.delete(id);
          slotGate.current.release();
        }
      })();
    },
    [append, getCurrentPrefix, onUploaded, patch],
  );

  const enqueue = useCallback(
    (file: File) => {
      uploadSequence += 1;
      const id = uploadSequence;
      const originPrefix = getCurrentPrefix();
      pending.current.set(id, { file, originPrefix });

      setUploads((current) => [
        {
          id,
          fileName: file.name,
          status: "uploading",
          detail: "Queued",
          uploadedParts: 0,
          totalParts: 0,
          originPrefix,
        },
        ...current,
      ]);

      runUpload(id, file, originPrefix, false);
    },
    [getCurrentPrefix, runUpload],
  );

  const retryOverwrite = useCallback(
    (id: number) => {
      const item = pending.current.get(id);
      if (!item) {
        return;
      }
      patch(id, (current) => ({ ...current, status: "uploading", detail: "Retrying with overwrite" }));
      runUpload(id, item.file, item.originPrefix, true);
    },
    [patch, runUpload],
  );

  const skip = useCallback(
    (id: number) => {
      pending.current.delete(id);
      patch(id, (item) => ({ ...item, status: "cancelled", detail: "Skipped" }));
    },
    [patch],
  );

  const cancel = useCallback((id: number) => {
    controllers.current.get(id)?.abort();
  }, []);

  const clearFinished = useCallback(() => {
    setUploads((current) =>
      current.filter((item) => {
        const keep = item.status === "uploading" || item.status === "conflict";
        if (!keep) {
          pending.current.delete(item.id);
        }
        return keep;
      }),
    );
  }, []);

  return { uploads, enqueue, cancel, retryOverwrite, skip, clearFinished };
}
