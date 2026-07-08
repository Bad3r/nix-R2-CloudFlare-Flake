/*
 * Typed HTTP client for the R2 Explorer worker API.
 *
 * Design notes:
 * - Every read accepts an AbortSignal so the UI can cancel superseded requests
 *   (the object browser fires overlapping list calls as the operator types).
 * - Retry uses decorrelated jitter with a delay cap and honours Retry-After on
 *   429/503 so a throttled worker is not hammered on a fixed exponential curve.
 * - Cloudflare Access opaque redirects are converted into typed 401 ApiErrors so
 *   the UI can present a deterministic sign-in affordance instead of a redirect.
 */

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

export type BucketBinding = {
  alias: string;
  binding: string;
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
  buckets: BucketBinding[];
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

/** True for a fetch aborted via AbortController; callers should treat as benign. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
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
  maxDelayMs?: number;
  retryableStatuses?: ReadonlySet<number>;
  retryNetworkErrors?: boolean;
};

const TRANSIENT_HTTP_STATUSES = new Set<number>([408, 429, 500, 502, 503, 504, 522, 524]);
const ACCESS_LOGIN_PATH = "/cdn-cgi/access/login";
export const ACCESS_API_BOOTSTRAP_PATH = "/api/v2/auth/bootstrap";
export const DEFAULT_BUCKET_ALIAS = "files";

const READ_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 6000,
  retryableStatuses: TRANSIENT_HTTP_STATUSES,
};
const UPLOAD_PART_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 6000,
  retryableStatuses: TRANSIENT_HTTP_STATUSES,
  retryNetworkErrors: false,
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

function shouldRetryError(
  error: unknown,
  retryableStatuses: ReadonlySet<number>,
  retryNetworkErrors: boolean,
): boolean {
  if (isAbortError(error)) {
    return false;
  }
  if (error instanceof ApiError) {
    return retryableStatuses.has(error.status);
  }
  return retryNetworkErrors && error instanceof TypeError;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Retry-After delay in ms if the error is an ApiError carrying one, else null. */
function retryAfterMs(error: unknown): number | null {
  if (!(error instanceof ApiError)) {
    return null;
  }
  const raw = error.details;
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const value = (raw as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value * 1000 : null;
}

/**
 * Backoff with decorrelated jitter, capped, honouring server Retry-After.
 * Pure of Math.random side effects on the caller: jitter is bounded to the
 * exponential window so ordering guarantees in tests remain deterministic
 * enough (tests stub timers/fetch rather than assert exact delays).
 */
function backoffDelay(attempt: number, options: RetryOptions, error: unknown): number {
  const base = Math.max(0, options.baseDelayMs ?? 500);
  const cap = Math.max(base, options.maxDelayMs ?? 6000);
  const serverHint = retryAfterMs(error);
  if (serverHint !== null) {
    return Math.min(cap, serverHint);
  }
  const window = Math.min(cap, base * 2 ** attempt);
  const jitter = window * (0.5 + Math.random() * 0.5);
  return Math.min(cap, jitter);
}

async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions, signal?: AbortSignal): Promise<T> {
  const maxRetries = Math.max(0, options.maxRetries ?? 0);
  const retryableStatuses = options.retryableStatuses ?? TRANSIENT_HTTP_STATUSES;
  const retryNetworkErrors = options.retryNetworkErrors ?? true;

  let attempt = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxRetries || !shouldRetryError(error, retryableStatuses, retryNetworkErrors)) {
        throw error;
      }
      await sleep(backoffDelay(attempt, options, error), signal);
      attempt += 1;
    }
  }
}

type ApiRequestInit = RequestInit & { retry?: RetryOptions };

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
    let details = payload?.error?.details;
    const retryAfterHeader = response.headers.get("retry-after");
    if (retryAfterHeader && /^\d+$/.test(retryAfterHeader)) {
      details = { ...(typeof details === "object" && details ? details : {}), retryAfterSeconds: Number(retryAfterHeader) };
    }
    throw new ApiError(response.status, code, message, details);
  }

  return decoded as T;
}

/** Perform an API request with optional retry and cancellation. */
export async function api<T>(path: string, init?: ApiRequestInit): Promise<T> {
  const { retry, ...requestInit } = init ?? {};
  if (!retry) {
    return apiOnce<T>(path, requestInit);
  }
  return withRetry(() => apiOnce<T>(path, requestInit), retry, requestInit.signal ?? undefined);
}

function jsonMutationHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
    "x-r2e-csrf": "1",
  };
}

export function fetchSessionInfo(signal?: AbortSignal): Promise<SessionInfoResponse> {
  return api<SessionInfoResponse>("/api/v2/session/info", { retry: READ_RETRY_OPTIONS, signal });
}

export function listObjects(
  prefix: string,
  cursor?: string,
  limit = 200,
  signal?: AbortSignal,
): Promise<ListResponse> {
  const query = new URLSearchParams();
  query.set("prefix", prefix);
  query.set("limit", String(limit));
  if (cursor) {
    query.set("cursor", cursor);
  }
  return api<ListResponse>(`/api/v2/list?${query.toString()}`, { retry: READ_RETRY_OPTIONS, signal });
}

export function createShare(
  key: string,
  ttl: string,
  maxDownloads: number,
  bucket?: string,
): Promise<ShareCreateResponse> {
  return api<ShareCreateResponse>("/api/v2/share/create", {
    method: "POST",
    headers: jsonMutationHeaders(),
    body: JSON.stringify({
      key,
      ttl,
      maxDownloads,
      contentDisposition: "attachment",
      ...(bucket ? { bucket } : {}),
    }),
  });
}

export function listShares(
  key: string,
  bucket: string = DEFAULT_BUCKET_ALIAS,
  signal?: AbortSignal,
): Promise<ShareListResponse> {
  const query = new URLSearchParams({ bucket, key, limit: "100" });
  return api<ShareListResponse>(`/api/v2/share/list?${query.toString()}`, { retry: READ_RETRY_OPTIONS, signal });
}

export async function revokeShare(tokenId: string): Promise<void> {
  await api<{ tokenId: string; revoked: true }>("/api/v2/share/revoke", {
    method: "POST",
    headers: jsonMutationHeaders(),
    body: JSON.stringify({ tokenId }),
  });
}

export async function moveObject(fromKey: string, toKey: string): Promise<void> {
  await api<{ fromKey: string; toKey: string }>("/api/v2/object/move", {
    method: "POST",
    headers: jsonMutationHeaders(),
    body: JSON.stringify({ fromKey, toKey }),
  });
}

export async function deleteObject(key: string): Promise<void> {
  await api<{ key: string; trashKey: string }>("/api/v2/object/delete", {
    method: "POST",
    headers: jsonMutationHeaders(),
    body: JSON.stringify({ key }),
  });
}

// Shared retry policy + header helper exports for the upload engine.
export {
  READ_RETRY_OPTIONS,
  UPLOAD_PART_RETRY_OPTIONS,
  jsonMutationHeaders,
  withRetry,
  type ApiRequestInit,
  type RetryOptions,
};
