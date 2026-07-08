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
  jsonMutationHeaders,
  withRetry,
  type UploadInitResponse,
  type UploadSignPartResponse,
} from "./api";

export type UploadProgress = {
  phase: "init" | "sign" | "upload" | "complete";
  uploadedParts: number;
  totalParts: number;
};

export type UploadOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  /** Max concurrent part transfers; clamped to [1, totalParts]. */
  concurrency?: number;
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

type Chunk = { partNumber: number; blob: Blob; size: number };

function sliceIntoChunks(file: File, partSize: number): Chunk[] {
  const chunks: Chunk[] = [];
  if (file.size === 0) {
    // A zero-byte object is a single empty part so completion has >= 1 part.
    chunks.push({ partNumber: 1, blob: file.slice(0, 0), size: 0 });
    return chunks;
  }
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
  const { signal, onProgress } = options;

  const initPayload = await api<UploadInitResponse>("/api/v2/upload/init", {
    method: "POST",
    headers: jsonMutationHeaders(),
    signal,
    body: JSON.stringify({
      filename: file.name,
      prefix,
      declaredSize: file.size,
      contentType: file.type || "application/octet-stream",
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
      // Signing is safe to retry (idempotent on the session), unlike the PUT.
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

    return await api<{ key: string }>("/api/v2/upload/complete", {
      method: "POST",
      headers: jsonMutationHeaders(),
      signal,
      body: JSON.stringify({
        sessionId: initPayload.sessionId,
        uploadId: initPayload.uploadId,
        finalSize: file.size,
        parts,
      }),
    });
  } catch (error) {
    // Best-effort abort so R2 does not retain orphaned parts on failure/cancel.
    await api<{ ok: true }>("/api/v2/upload/abort", {
      method: "POST",
      headers: jsonMutationHeaders(),
      body: JSON.stringify({ sessionId: initPayload.sessionId, uploadId: initPayload.uploadId }),
    }).catch(() => undefined);
    throw error;
  }
}
