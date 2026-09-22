/*
 * Direct browser-to-R2 multipart upload engine.
 *
 * The worker signs each part; the browser PUTs bytes straight to R2. Extracted
 * from the API client so the transfer state machine (chunking, a bounded worker
 * pool, per-part re-signing on retry, and guaranteed abort on failure) lives in
 * one focused module.
 */

import {
  api,
  ApiError,
  UPLOAD_PART_RETRY_OPTIONS,
  isAbortError,
  jsonMutationHeaders,
  retryAfterMs,
  sleep,
  withRetry,
  type RetryOptions,
  type UploadInitResponse,
  type UploadSignPartResponse,
} from "./api";

const UPLOAD_INIT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
  // Only statuses the worker returns before creating a session: the per-user
  // concurrency 429 and an overloaded 503, both honoring Retry-After. Network
  // errors are not retried because a dropped response may have created the
  // session server-side, and init is not idempotent.
  retryableStatuses: new Set([429, 503]),
  retryNetworkErrors: false,
};

const UPLOAD_COMPLETE_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 6000,
  // Unlike init, complete is idempotent: repeating it after a success replays
  // the same payload, and repeating it after a failed promotion resumes it
  // instead of failing. Both the shared transient statuses (default when
  // retryableStatuses is omitted) and network errors are safe to retry here.
  // 409 upload_promotion_in_progress is deliberately not added here: it is
  // not a transient failure to retry a few times, it is handled below by
  // completeWithPromotionWait, which waits out the advertised delay instead.
  retryNetworkErrors: true,
};

// Per-wait delay when complete answers 409 upload_promotion_in_progress:
// honors the server's retryAfterSeconds but never below 1s or above 30s.
const PROMOTION_WAIT_MIN_MS = 1000;
const PROMOTION_WAIT_MAX_MS = 30000;
// The server's promotion lease (upload-sessions Durable Object) lives 15
// minutes; bound the total wait a bit past that so the client only gives up
// after the server itself would have let a fresh complete take over the lease.
const PROMOTION_WAIT_BOUND_MS = 20 * 60 * 1000;

export type UploadProgress = {
  phase: "init" | "sign" | "upload" | "complete" | "finalizing";
  uploadedParts: number;
  totalParts: number;
};

export type UploadOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  /** Max concurrent part transfers; clamped to [1, totalParts]. */
  concurrency?: number;
  /** Replace an existing object at the target key; the server keeps a copy of it in .trash/. */
  overwrite?: boolean;
};

const DEFAULT_CONCURRENCY = 4;

const FORBIDDEN_BROWSER_UPLOAD_HEADERS = new Set([
  "content-length",
  "host",
  "origin",
  "referer",
  "cookie",
  "set-cookie",
  "set-cookie2",
]);

function isForbiddenBrowserUploadHeader(name: string): boolean {
  if (FORBIDDEN_BROWSER_UPLOAD_HEADERS.has(name)) {
    return true;
  }
  return name.startsWith("sec-") || name.startsWith("proxy-");
}

function buildUploadRequestHeaders(signedHeaders: Record<string, string> | undefined): Headers {
  const headers = new Headers();
  if (!signedHeaders) {
    return headers;
  }
  for (const [rawName, rawValue] of Object.entries(signedHeaders)) {
    const name = rawName.trim().toLowerCase();
    if (name.length === 0 || isForbiddenBrowserUploadHeader(name)) {
      continue;
    }
    headers.set(name, rawValue);
  }
  return headers;
}

/** True for the 409 the worker returns while an earlier complete is still promoting this upload. */
function isPromotionInProgress(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409 && error.code === "upload_promotion_in_progress";
}

/**
 * Thrown instead of a plain AbortError when the user cancels while the server
 * is still promoting the upload: the client stops waiting, but the server
 * keeps going and refuses abort, so the object may still appear.
 */
export class UploadCancelledDuringPromotionError extends Error {
  constructor() {
    super("Cancelled while the server was still finalizing this upload; the object may still appear in the listing.");
    this.name = "UploadCancelledDuringPromotionError";
  }
}

export function isCancelledDuringPromotion(error: unknown): error is UploadCancelledDuringPromotionError {
  return error instanceof UploadCancelledDuringPromotionError;
}

/** Server-advertised wait before re-asking, clamped to [PROMOTION_WAIT_MIN_MS, PROMOTION_WAIT_MAX_MS]. */
function promotionRetryDelayMs(error: ApiError): number {
  const advertised = retryAfterMs(error) ?? PROMOTION_WAIT_MIN_MS;
  return Math.min(PROMOTION_WAIT_MAX_MS, Math.max(PROMOTION_WAIT_MIN_MS, advertised));
}

type Chunk = { partNumber: number; blob: Blob; size: number };

function sliceIntoChunks(file: File, partSize: number): Chunk[] {
  // Zero-byte files never reach this point: multipartUpload rejects them
  // client-side, and upload/init also requires a positive declaredSize.
  const chunks: Chunk[] = [];
  for (let offset = 0, partNumber = 1; offset < file.size; offset += partSize, partNumber += 1) {
    const blob = file.slice(offset, offset + partSize);
    chunks.push({ partNumber, blob, size: blob.size });
  }
  return chunks;
}

/**
 * Upload a file as an R2 multipart object and return its stored key.
 *
 * On any failure the in-flight upload is aborted so R2 does not retain orphaned
 * parts. Each part is (re-)signed inside the retry loop, so a signed URL that
 * expires mid-backoff is replaced with a fresh one rather than retried to
 * certain failure.
 */
export async function multipartUpload(file: File, prefix: string, options: UploadOptions = {}): Promise<{ key: string }> {
  const { signal, onProgress, overwrite = false } = options;

  if (file.size === 0) {
    throw new ApiError(400, "upload_empty_file", "Cannot upload an empty file.");
  }

  const initPayload = await api<UploadInitResponse>("/api/v2/upload/init", {
    method: "POST",
    headers: jsonMutationHeaders(),
    signal,
    retry: UPLOAD_INIT_RETRY_OPTIONS,
    body: JSON.stringify({
      filename: file.name,
      prefix,
      declaredSize: file.size,
      // Omitted (not defaulted to a generic type) when the browser did not
      // report one, so the server's own extension-based guess applies.
      ...(file.type ? { contentType: file.type } : {}),
      ...(overwrite ? { overwrite: true } : {}),
    }),
  });

  onProgress?.({ phase: "init", uploadedParts: 0, totalParts: 0 });

  const chunks = sliceIntoChunks(file, initPayload.partSizeBytes);
  const totalParts = chunks.length;
  const partEtags = new Map<number, string>();
  let uploadedParts = 0;
  const concurrency = Math.min(Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY), totalParts);
  let cursor = 0;

  const signPart = async (partNumber: number, contentLength: number): Promise<UploadSignPartResponse> =>
    api<UploadSignPartResponse>("/api/v2/upload/sign-part", {
      method: "POST",
      headers: jsonMutationHeaders(),
      signal,
      body: JSON.stringify({
        sessionId: initPayload.sessionId,
        uploadId: initPayload.uploadId,
        partNumber,
        contentLength,
      }),
      // Signing is idempotent on the session, and the part PUT itself is
      // idempotent too (same bytes, same partNumber), so both retry.
      retry: UPLOAD_PART_RETRY_OPTIONS,
    });

  const uploadPart = async (partNumber: number, blob: Blob, contentLength: number): Promise<void> => {
    // Re-sign on every attempt so an expired part URL cannot doom the retry.
    const response = await withRetry(
      async () => {
        onProgress?.({ phase: "sign", uploadedParts, totalParts });
        const signed = await signPart(partNumber, contentLength);
        let partResponse: Response;
        try {
          partResponse = await fetch(signed.url, {
            method: signed.method,
            headers: buildUploadRequestHeaders(signed.headers),
            body: blob,
            signal,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new ApiError(
            0,
            "upload_part_request_failed",
            `Part upload request could not be sent for ${partNumber}/${totalParts}: ${detail}`,
          );
        }
        if (!partResponse.ok) {
          const detail = await partResponse.text().catch(() => "");
          throw new ApiError(
            partResponse.status,
            "upload_part_failed",
            `Part upload failed for ${partNumber}/${totalParts}${detail ? `: ${detail.slice(0, 180)}` : ""}`,
          );
        }
        return partResponse;
      },
      UPLOAD_PART_RETRY_OPTIONS,
      signal,
    );

    const etag = response.headers.get("etag");
    if (!etag) {
      throw new ApiError(
        500,
        "missing_etag",
        "Signed upload response is missing ETag. Ensure R2 bucket CORS exposes ETag.",
      );
    }
    partEtags.set(partNumber, etag.replace(/^"|"$/g, ""));
    uploadedParts += 1;
    onProgress?.({ phase: "upload", uploadedParts, totalParts });
  };

  const poolWorker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= chunks.length) {
        return;
      }
      const chunk = chunks[index];
      await uploadPart(chunk.partNumber, chunk.blob, chunk.size);
    }
  };

  /**
   * POST complete, waiting out a promotion_in_progress 409 (an earlier
   * complete for this session is still promoting the staged upload to its
   * final key) instead of failing. Every other error is rethrown immediately.
   */
  const completeWithPromotionWait = async (parts: { partNumber: number; etag: string }[]): Promise<{ key: string }> => {
    const body = JSON.stringify({
      sessionId: initPayload.sessionId,
      uploadId: initPayload.uploadId,
      finalSize: file.size,
      parts,
      ...(overwrite ? { overwrite: true } : {}),
    });
    const waitDeadline = Date.now() + PROMOTION_WAIT_BOUND_MS;
    let promoting = false;
    for (;;) {
      try {
        return await api<{ key: string }>("/api/v2/upload/complete", {
          method: "POST",
          headers: jsonMutationHeaders(),
          signal,
          retry: UPLOAD_COMPLETE_RETRY_OPTIONS,
          body,
        });
      } catch (error) {
        if (promoting && isAbortError(error)) {
          throw new UploadCancelledDuringPromotionError();
        }
        if (!isPromotionInProgress(error)) {
          throw error;
        }
        promoting = true;
        if (Date.now() >= waitDeadline) {
          throw new ApiError(
            error.status,
            error.code,
            "The server is still finalizing this upload; the object may appear shortly. Check the listing again in a few minutes.",
            error.details,
          );
        }
        onProgress?.({ phase: "finalizing", uploadedParts, totalParts });
        try {
          await sleep(promotionRetryDelayMs(error), signal);
        } catch (sleepError) {
          throw isAbortError(sleepError) ? new UploadCancelledDuringPromotionError() : sleepError;
        }
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, () => poolWorker()));

    const parts = chunks.map((chunk) => {
      const etag = partEtags.get(chunk.partNumber);
      if (!etag) {
        throw new ApiError(500, "missing_part_etag", `Missing uploaded ETag for part ${chunk.partNumber}.`);
      }
      return { partNumber: chunk.partNumber, etag };
    });

    onProgress?.({ phase: "complete", uploadedParts, totalParts });

    return await completeWithPromotionWait(parts);
  } catch (error) {
    if (isPromotionInProgress(error) || isCancelledDuringPromotion(error)) {
      // Never abort here: the worker refuses abort with this same 409 while
      // its lease is held, and giving up must not race a promotion that may
      // still succeed after the client stops waiting.
      throw error;
    }
    // Best-effort abort so R2 does not retain orphaned parts on failure/cancel.
    await api<{ ok: true }>("/api/v2/upload/abort", {
      method: "POST",
      headers: jsonMutationHeaders(),
      body: JSON.stringify({ sessionId: initPayload.sessionId, uploadId: initPayload.uploadId }),
    }).catch(() => undefined);
    throw error;
  }
}
