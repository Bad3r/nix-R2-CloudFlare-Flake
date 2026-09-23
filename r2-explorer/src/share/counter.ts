import { apiError, HttpError, json, parseJsonText } from "./../http";

/** Storage key holding the monotonically increasing download count. */
const COUNT_STORAGE_KEY = "count";

/** Storage key for the authoritative revoked flag; set only by /revoke, never cleared. */
const REVOKED_STORAGE_KEY = "revoked";

/** Storage key for the epoch-ms timestamp of the last counted download start, used to recognize a resume. */
const LAST_START_STORAGE_KEY = "lastStartAtMs";

/**
 * Keep counter storage around for a day past share expiry before the cleanup
 * alarm wipes it, covering clock skew and late KV-consistent readers.
 */
const COUNTER_RETENTION_MS = 24 * 60 * 60 * 1000;

type ConsumeRequest = {
  tokenId: string;
  maxDownloads: number;
  expiresAtMs: number;
  downloadCount: number;
  /** True for a Range request serving bytes past offset 0; see handleConsume. */
  isContinuation: boolean;
  /** Caller-supplied resume grace period; the constant lives in share/service.ts. */
  resumeWindowMs: number;
};

type StatusRequest = {
  tokenId: string;
  maxDownloads: number;
  expiresAtMs: number;
  downloadCount: number;
  /** Same meaning as ConsumeRequest.isContinuation; see handleStatus. */
  isContinuation: boolean;
  resumeWindowMs: number;
};

type RevokeRequest = {
  tokenId: string;
  expiresAtMs: number;
};

function requirePayloadObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "validation_error", "Request payload must be a JSON object.");
  }
  return input as Record<string, unknown>;
}

function requireNonEmptyString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, "validation_error", `${field} must be a non-empty string.`);
  }
  return value;
}

function requireNonNegativeInt(payload: Record<string, unknown>, field: string): number {
  const value = payload[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new HttpError(400, "validation_error", `${field} must be a non-negative integer.`);
  }
  return value;
}

function requireEpochMs(payload: Record<string, unknown>, field: string): number {
  const value = payload[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "validation_error", `${field} must be a finite epoch-milliseconds number.`);
  }
  return value;
}

function optionalNonNegativeInt(payload: Record<string, unknown>, field: string, fallback: number): number {
  const value = payload[field];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new HttpError(400, "validation_error", `${field} must be a non-negative integer when provided.`);
  }
  return value;
}

function optionalBoolean(payload: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = payload[field];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new HttpError(400, "validation_error", `${field} must be a boolean when provided.`);
  }
  return value;
}

function parseConsumeRequest(input: unknown): ConsumeRequest {
  const payload = requirePayloadObject(input);
  return {
    tokenId: requireNonEmptyString(payload, "tokenId"),
    maxDownloads: requireNonNegativeInt(payload, "maxDownloads"),
    expiresAtMs: requireEpochMs(payload, "expiresAtMs"),
    downloadCount: optionalNonNegativeInt(payload, "downloadCount", 0),
    isContinuation: optionalBoolean(payload, "isContinuation", false),
    resumeWindowMs: optionalNonNegativeInt(payload, "resumeWindowMs", 0),
  };
}

function parseStatusRequest(input: unknown): StatusRequest {
  const payload = requirePayloadObject(input);
  return {
    tokenId: requireNonEmptyString(payload, "tokenId"),
    maxDownloads: requireNonNegativeInt(payload, "maxDownloads"),
    expiresAtMs: requireEpochMs(payload, "expiresAtMs"),
    downloadCount: optionalNonNegativeInt(payload, "downloadCount", 0),
    isContinuation: optionalBoolean(payload, "isContinuation", false),
    resumeWindowMs: optionalNonNegativeInt(payload, "resumeWindowMs", 0),
  };
}

function parseRevokeRequest(input: unknown): RevokeRequest {
  const payload = requirePayloadObject(input);
  return {
    tokenId: requireNonEmptyString(payload, "tokenId"),
    expiresAtMs: requireEpochMs(payload, "expiresAtMs"),
  };
}

/**
 * Durable Object enforcing share download caps and revocation. Each share
 * token maps to its own instance (idFromName(tokenId)), so every read-
 * modify-write here is serialized by the Durable Object input gate: two
 * concurrent downloads can never both consume the final slot, and a revoke
 * can never interleave with a consume it should have blocked. The KV share
 * record keeps a display-only copy of the count; this object is the
 * authoritative gate for maxDownloads, expiry, and revocation alike.
 */
export class ShareCounterDurableObject {
  constructor(private readonly state: DurableObjectState) {}

  /**
   * Cleanup alarm: the share token is past its expiry plus retention, so the
   * counter storage is no longer needed.
   */
  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }

  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method.toUpperCase() !== "POST") {
        return apiError(405, "method_not_allowed", "Only POST is supported for the share counter.");
      }

      const url = new URL(request.url);
      if (url.pathname === "/consume") {
        return await this.handleConsume(parseConsumeRequest(parseJsonText(await request.text())));
      }
      if (url.pathname === "/status") {
        return await this.handleStatus(parseStatusRequest(parseJsonText(await request.text())));
      }
      if (url.pathname === "/revoke") {
        return await this.handleRevoke(parseRevokeRequest(parseJsonText(await request.text())));
      }
      return apiError(404, "not_found", "Share counter route not found.");
    } catch (error) {
      if (error instanceof HttpError) {
        return apiError(error.status, error.code, error.message, error.details);
      }
      console.error("Unhandled share counter error:", error);
      return apiError(500, "internal_error", "Unexpected share counter error.");
    }
  }

  private async ensureRetentionAlarm(expiresAtMs: number): Promise<void> {
    const existingAlarm = await this.state.storage.getAlarm();
    if (existingAlarm === null) {
      await this.state.storage.setAlarm(expiresAtMs + COUNTER_RETENTION_MS);
    }
  }

  /**
   * Revoked and expiry are checked first, refusing every request type
   * including continuations. A continuation inside the resume window is then
   * free even if the cap is already reached (the resume case for
   * maxDownloads = 1); outside the window, or with no prior recorded start,
   * it is treated exactly like a fresh download start. No awaits between the
   * reads and the write other than storage calls, so the Durable Object
   * input gate keeps this atomic.
   */
  private async handleConsume(body: ConsumeRequest): Promise<Response> {
    const revoked = (await this.state.storage.get<boolean>(REVOKED_STORAGE_KEY)) ?? false;
    if (revoked) {
      throw new HttpError(410, "share_expired", "Share token is expired, revoked, or exhausted.");
    }
    if (Date.now() >= body.expiresAtMs) {
      throw new HttpError(410, "share_expired", "Share token is expired, revoked, or exhausted.");
    }

    // On the first consume the DO has no stored count yet, so it seeds from
    // the KV record's downloadCount: a share migrated from the old KV-only
    // accounting keeps its already-spent downloads instead of restarting at
    // zero and regaining its full quota. Afterwards the stored count wins.
    const storedCount = await this.state.storage.get<number>(COUNT_STORAGE_KEY);
    const currentCount = storedCount ?? body.downloadCount;

    if (body.isContinuation) {
      const lastStartAtMs = await this.state.storage.get<number>(LAST_START_STORAGE_KEY);
      const withinResumeWindow =
        typeof lastStartAtMs === "number" && Date.now() - lastStartAtMs <= body.resumeWindowMs;
      if (withinResumeWindow) {
        return json({ count: currentCount, consumed: false });
      }
      // No recorded start (including a counter holding only a legacy count
      // key), or it aged out of the window: fall through and treat this
      // range request exactly like a fresh download start.
    }

    if (body.maxDownloads > 0 && currentCount >= body.maxDownloads) {
      throw new HttpError(410, "share_expired", "Share token is expired, revoked, or exhausted.");
    }
    const updated = currentCount + 1;
    await this.state.storage.put({
      [COUNT_STORAGE_KEY]: updated,
      [LAST_START_STORAGE_KEY]: Date.now(),
    });
    await this.ensureRetentionAlarm(body.expiresAtMs);
    return json({ count: updated, consumed: true });
  }

  /**
   * Read-only: reports the authoritative revoked/exhausted state and count
   * without touching storage, for requests that must never write (readonly
   * mode, HEAD, and GET outcomes with no body: 304/412/416). `exhausted`
   * grants the same resume-window exemption handleConsume grants a
   * continuation: when the caller's own request shape is a continuation
   * (isContinuation true) and the token has a counted start within
   * resumeWindowMs, reaching the cap alone does not count as exhausted,
   * because the question this answers is "would a GET carrying the same
   * headers be refused", and such a GET would be granted the free resume.
   * Revoked and expiry are never exempted by this rule.
   */
  private async handleStatus(body: StatusRequest): Promise<Response> {
    const revoked = (await this.state.storage.get<boolean>(REVOKED_STORAGE_KEY)) ?? false;
    const storedCount = await this.state.storage.get<number>(COUNT_STORAGE_KEY);
    const count = storedCount ?? body.downloadCount;
    const expired = Date.now() >= body.expiresAtMs;

    let capExhausted = body.maxDownloads > 0 && count >= body.maxDownloads;
    if (capExhausted && body.isContinuation) {
      const lastStartAtMs = await this.state.storage.get<number>(LAST_START_STORAGE_KEY);
      const withinResumeWindow =
        typeof lastStartAtMs === "number" && Date.now() - lastStartAtMs <= body.resumeWindowMs;
      if (withinResumeWindow) {
        capExhausted = false;
      }
    }

    return json({ revoked, exhausted: expired || capExhausted, count });
  }

  /** Idempotent: a repeated revoke just re-sets the same flag. */
  private async handleRevoke(body: RevokeRequest): Promise<Response> {
    await this.state.storage.put(REVOKED_STORAGE_KEY, true);
    await this.ensureRetentionAlarm(body.expiresAtMs);
    return json({ revoked: true });
  }
}
