import { useCallback, useRef, useState } from "preact/hooks";
import { isAbortError } from "../lib/api";
import { errorMessage } from "../lib/format";
import { multipartUpload, type UploadProgress } from "../lib/upload";
import type { ActivityLog } from "./useActivityLog";

export type UploadStatus = "uploading" | "done" | "error" | "cancelled";

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
  clearFinished: () => void;
};

type UploadArgs = {
  log: Pick<ActivityLog, "append">;
  getCurrentPrefix: () => string;
  onUploaded: () => void;
};

let uploadSequence = 0;

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

  const patch = useCallback((id: number, updater: (item: UploadItem) => UploadItem) => {
    setUploads((current) => current.map((item) => (item.id === id ? updater(item) : item)));
  }, []);

  const enqueue = useCallback(
    (file: File) => {
      uploadSequence += 1;
      const id = uploadSequence;
      const originPrefix = getCurrentPrefix();
      const controller = new AbortController();
      controllers.current.set(id, controller);

      setUploads((current) => [
        {
          id,
          fileName: file.name,
          status: "uploading",
          detail: "Initializing",
          uploadedParts: 0,
          totalParts: 0,
          originPrefix,
        },
        ...current,
      ]);

      void (async () => {
        try {
          const completed = await multipartUpload(file, originPrefix, {
            signal: controller.signal,
            onProgress: (progress: UploadProgress) => {
              patch(id, (item) => ({
                ...item,
                status: "uploading",
                detail: `Phase ${progress.phase}`,
                uploadedParts: progress.uploadedParts,
                totalParts: progress.totalParts,
              }));
            },
          });
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
          if (isAbortError(error)) {
            patch(id, (item) => ({ ...item, status: "cancelled", detail: "Cancelled" }));
            append(`Upload cancelled for ${file.name}`, "info");
            return;
          }
          const message = errorMessage(error);
          patch(id, (item) => ({ ...item, status: "error", detail: message }));
          append(`Upload failed for ${file.name}: ${message}`, "error");
        } finally {
          controllers.current.delete(id);
        }
      })();
    },
    [append, getCurrentPrefix, onUploaded, patch],
  );

  const cancel = useCallback((id: number) => {
    controllers.current.get(id)?.abort();
  }, []);

  const clearFinished = useCallback(() => {
    setUploads((current) => current.filter((item) => item.status === "uploading"));
  }, []);

  return { uploads, enqueue, cancel, clearFinished };
}
