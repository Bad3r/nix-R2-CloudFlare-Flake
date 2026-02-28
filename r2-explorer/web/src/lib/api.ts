export type RequestActor = {
  mode: "access";
  actor: string;
};

export type ObjectMetadata = {
  key: string;
  size: number;
  etag: string;
  uploaded: string | null;
  storageClass: string | null;
};

export type ListResponse = {
  prefix: string;
  cursor?: string;
  listComplete: boolean;
  delimitedPrefixes: string[];
  objects: ObjectMetadata[];
  identity: RequestActor;
};

export type ShareRecord = {
  tokenId: string;
  bucket: string;
  key: string;
  createdAt: string;
  expiresAt: string;
  maxDownloads: number;
  downloadCount: number;
  revoked: boolean;
  createdBy: string;
  contentDisposition: "attachment" | "inline";
};

export type ShareListResponse = {
  shares: ShareRecord[];
  cursor?: string;
  listComplete: boolean;
};

export type ShareCreateResponse = {
  tokenId: string;
  url: string;
  expiresAt: string;
  maxDownloads: number;
  bucket: string;
  key: string;
};

export type UploadInitResponse = {
  sessionId: string;
  objectKey: string;
  uploadId: string;
  expiresAt: string;
  partSizeBytes: number;
  maxParts: number;
  signPartTtlSec: number;
  allowedMime: string[];
  allowedExt: string[];
};

export type UploadSignPartResponse = {
  sessionId: string;
  uploadId: string;
  partNumber: number;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
};

export type SessionInfoResponse = {
  version: string;
  readonly: boolean;
  actor: RequestActor;
  limits: {
    uiMaxListLimit: number;
    upload: {
      maxFileBytes: number;
      maxParts: number;
      maxConcurrentPerUser: number;
      sessionTtlSec: number;
      signPartTtlSec: number;
      partSizeBytes: number;
      allowedMime: string[];
      blockedMime: string[];
      allowedExtensions: string[];
      blockedExtensions: string[];
      prefixAllowlist: string[];
    };
  };
  buckets: Array<{
    alias: string;
    binding: string;
  }>;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type ApiErrorPayload = {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
};

type RetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  retryableStatuses?: ReadonlySet<number>;
};

const TRANSIENT_HTTP_STATUSES = new Set<number>([408, 429, 500, 502, 503, 504, 522, 524]);
const ACCESS_LOGIN_PATH = "/cdn-cgi/access/login";
export const ACCESS_API_BOOTSTRAP_PATH = "/api/v2/auth/bootstrap";
const READ_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  retryableStatuses: TRANSIENT_HTTP_STATUSES,
};
const UPLOAD_PART_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  retryableStatuses: TRANSIENT_HTTP_STATUSES,
};

function isJsonResponse(response: Response): boolean {
  const header = response.headers.get("content-type");
  return Boolean(header && header.includes("application/json"));
}

async function decodeResponse<T>(response: Response): Promise<T | ApiErrorPayload | string | null> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  if (!isJsonResponse(response)) {
    return text;
  }
  try {
    return JSON.parse(text) as T | ApiErrorPayload;
  } catch {
    return text;
  }
}

function shouldRetryError(error: unknown, retryableStatuses: ReadonlySet<number>): boolean {
  if (error instanceof ApiError) {
    return retryableStatuses.has(error.status);
  }
  return error instanceof TypeError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const maxRetries = Math.max(0, options.maxRetries ?? 0);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 1000);
  const retryableStatuses = options.retryableStatuses ?? TRANSIENT_HTTP_STATUSES;

  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxRetries || !shouldRetryError(error, retryableStatuses)) {
        throw error;
      }
      const delayMs = baseDelayMs * 2 ** attempt;
      attempt += 1;
      await sleep(delayMs);
    }
  }
}

function withDefaultCredentials(init?: RequestInit): RequestInit {
  return {
    credentials: "same-origin",
    ...init,
    redirect: "manual",
  };
}

function isAccessLoginUrl(url: string | null): boolean {
  return Boolean(url && url.includes(ACCESS_LOGIN_PATH));
}

function isAccessRedirectResponse(response: Response): boolean {
  if (response.type === "opaqueredirect") {
    return true;
  }
  if (response.redirected && isAccessLoginUrl(response.url)) {
    return true;
  }
  if (response.status >= 300 && response.status < 400 && isAccessLoginUrl(response.headers.get("location"))) {
    return true;
  }
  return false;
}

async function apiOnce<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, withDefaultCredentials(init));
  if (isAccessRedirectResponse(response)) {
    throw new ApiError(401, "access_required", "Cloudflare Access sign-in is required.");
  }
  const decoded = await decodeResponse<T>(response);

  if (!response.ok) {
    const payload = typeof decoded === "object" && decoded !== null ? (decoded as ApiErrorPayload) : undefined;
    const code = payload?.error?.code ?? "request_failed";
    const message =
      payload?.error?.message ??
      (typeof decoded === "string" && decoded.length > 0 ? decoded : `${response.status} ${response.statusText}`);
    throw new ApiError(response.status, code, message, payload?.error?.details);
  }

  return decoded as T;
}

export async function api<T>(path: string, init?: RequestInit, retryOptions?: RetryOptions): Promise<T> {
  if (!retryOptions) {
    return apiOnce<T>(path, init);
  }
  return withRetry(() => apiOnce<T>(path, init), retryOptions);
}

function uploadJsonHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
    "x-r2e-csrf": "1",
  };
}

export async function fetchSessionInfo(): Promise<SessionInfoResponse> {
  return api<SessionInfoResponse>("/api/v2/session/info", undefined, READ_RETRY_OPTIONS);
}

export async function listObjects(prefix: string, cursor?: string, limit = 200): Promise<ListResponse> {
  const query = new URLSearchParams();
  query.set("prefix", prefix);
  query.set("limit", String(limit));
  if (cursor) {
    query.set("cursor", cursor);
  }
  return api<ListResponse>(`/api/v2/list?${query.toString()}`, undefined, READ_RETRY_OPTIONS);
}

export async function createShare(key: string, ttl: string, maxDownloads: number): Promise<ShareCreateResponse> {
  return api<ShareCreateResponse>("/api/v2/share/create", {
    method: "POST",
    headers: uploadJsonHeaders(),
    body: JSON.stringify({
      key,
      ttl,
      maxDownloads,
      contentDisposition: "attachment",
    }),
  });
}

export async function listShares(key: string): Promise<ShareListResponse> {
  const query = new URLSearchParams({
    bucket: "files",
    key,
    limit: "100",
  });
  return api<ShareListResponse>(`/api/v2/share/list?${query.toString()}`, undefined, READ_RETRY_OPTIONS);
}

export async function revokeShare(tokenId: string): Promise<void> {
  await api<{ tokenId: string; revoked: true }>("/api/v2/share/revoke", {
    method: "POST",
    headers: uploadJsonHeaders(),
    body: JSON.stringify({ tokenId }),
  });
}

export async function moveObject(fromKey: string, toKey: string): Promise<void> {
  await api<{ fromKey: string; toKey: string }>("/api/v2/object/move", {
    method: "POST",
    headers: uploadJsonHeaders(),
    body: JSON.stringify({ fromKey, toKey }),
  });
}

export async function deleteObject(key: string): Promise<void> {
  await api<{ key: string; trashKey: string }>("/api/v2/object/delete", {
    method: "POST",
    headers: uploadJsonHeaders(),
    body: JSON.stringify({ key }),
  });
}

export type UploadProgress = {
  phase: "init" | "sign" | "upload" | "complete";
  uploadedParts: number;
  totalParts: number;
};

export async function multipartUpload(
  file: File,
  prefix: string,
  onProgress?: (progress: UploadProgress) => void,
): Promise<{ key: string }> {
  const initPayload = await api<UploadInitResponse>("/api/v2/upload/init", {
    method: "POST",
    headers: uploadJsonHeaders(),
    body: JSON.stringify({
      filename: file.name,
      prefix,
      declaredSize: file.size,
      contentType: file.type || "application/octet-stream",
    }),
  });

  onProgress?.({ phase: "init", uploadedParts: 0, totalParts: 0 });

  const partSize = initPayload.partSizeBytes;
  const chunks: Array<{ partNumber: number; blob: Blob; size: number }> = [];
  for (let offset = 0, partNumber = 1; offset < file.size; offset += partSize, partNumber += 1) {
    const blob = file.slice(offset, offset + partSize);
    chunks.push({ partNumber, blob, size: blob.size });
  }

  const totalParts = chunks.length;
  const partEtagMap = new Map<number, string>();
  let uploadedParts = 0;
  const parallel = Math.min(4, Math.max(1, totalParts));
  let cursor = 0;

  async function uploadPart(partNumber: number, blob: Blob, contentLength: number): Promise<void> {
    onProgress?.({ phase: "sign", uploadedParts, totalParts });
    const signed = await api<UploadSignPartResponse>(
      "/api/v2/upload/sign-part",
      {
        method: "POST",
        headers: uploadJsonHeaders(),
        body: JSON.stringify({
          sessionId: initPayload.sessionId,
          uploadId: initPayload.uploadId,
          partNumber,
          contentLength,
        }),
      },
      UPLOAD_PART_RETRY_OPTIONS,
    );

    const response = await withRetry(async () => {
      const uploadHeaders = new Headers(signed.headers || {});
      const partResponse = await fetch(signed.url, {
        method: signed.method,
        headers: uploadHeaders,
        body: blob,
      });

      if (!partResponse.ok) {
        const detail = await partResponse.text().catch(() => "");
        throw new ApiError(
          partResponse.status,
          "upload_part_failed",
          `Part upload failed for ${partNumber}/${totalParts}${detail ? `: ${detail.slice(0, 180)}` : ""}`,
        );
      }
      return partResponse;
    }, UPLOAD_PART_RETRY_OPTIONS);

    const etag = response.headers.get("etag");
    if (!etag) {
      throw new ApiError(
        500,
        "missing_etag",
        "Signed upload response is missing ETag. Ensure R2 bucket CORS exposes ETag.",
      );
    }

    partEtagMap.set(partNumber, etag.replace(/^"|"$/g, ""));
    uploadedParts += 1;
    onProgress?.({ phase: "upload", uploadedParts, totalParts });
  }

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= chunks.length) {
        return;
      }
      const chunk = chunks[index];
      await uploadPart(chunk.partNumber, chunk.blob, chunk.size);
    }
  }

  try {
    await Promise.all(Array.from({ length: parallel }, () => worker()));

    const parts = chunks.map((chunk) => {
      const etag = partEtagMap.get(chunk.partNumber);
      if (!etag) {
        throw new ApiError(500, "missing_part_etag", `Missing uploaded ETag for part ${chunk.partNumber}.`);
      }
      return {
        partNumber: chunk.partNumber,
        etag,
      };
    });

    onProgress?.({ phase: "complete", uploadedParts, totalParts });

    const completed = await api<{ key: string }>("/api/v2/upload/complete", {
      method: "POST",
      headers: uploadJsonHeaders(),
      body: JSON.stringify({
        sessionId: initPayload.sessionId,
        uploadId: initPayload.uploadId,
        finalSize: file.size,
        parts,
      }),
    });

    return completed;
  } catch (error) {
    await api<{ ok: true }>("/api/v2/upload/abort", {
      method: "POST",
      headers: uploadJsonHeaders(),
      body: JSON.stringify({
        sessionId: initPayload.sessionId,
        uploadId: initPayload.uploadId,
      }),
    }).catch(() => undefined);
    throw error;
  }
}
