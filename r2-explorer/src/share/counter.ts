import { apiError, HttpError, json, parseJsonText } from "./../http";

/** Storage key holding the monotonically increasing download count. */
const COUNT_STORAGE_KEY = "count";

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
};

function parseConsumeRequest(input: unknown): ConsumeRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "validation_error", "Request payload must be a JSON object.");
  }
  const payload = input as Record<string, unknown>;
  const tokenId = payload.tokenId;
  if (typeof tokenId !== "string" || tokenId.trim().length === 0) {
    throw new HttpError(400, "validation_error", "tokenId must be a non-empty string.");
  }
  const maxDownloads = payload.maxDownloads;
  if (typeof maxDownloads !== "number" || !Number.isInteger(maxDownloads) || maxDownloads < 0) {
    throw new HttpError(400, "validation_error", "maxDownloads must be a non-negative integer.");
  }
  const expiresAtMs = payload.expiresAtMs;
  if (typeof expiresAtMs !== "number" || !Number.isFinite(expiresAtMs)) {
    throw new HttpError(400, "validation_error", "expiresAtMs must be a finite epoch-milliseconds number.");
  }
  const downloadCount = payload.downloadCount;
  if (
    downloadCount !== undefined &&
    (typeof downloadCount !== "number" || !Number.isInteger(downloadCount) || downloadCount < 0)
  ) {
    throw new HttpError(400, "validation_error", "downloadCount must be a non-negative integer when provided.");
  }
  return { tokenId, maxDownloads, expiresAtMs, downloadCount: downloadCount ?? 0 };
}

/**
 * Durable Object enforcing share download caps. Each share token maps to its
 * own instance (idFromName(tokenId)), so the read-modify-write on the count
 * is serialized by the Durable Object input gate and two concurrent
 * downloads can never both consume the final slot. The KV share record keeps
 * a display-only copy of the count; this object is the authoritative gate.
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
      if (url.pathname !== "/consume") {
        return apiError(404, "not_found", "Share counter route not found.");
      }

      const body = parseConsumeRequest(parseJsonText(await request.text()));
      if (Date.now() >= body.expiresAtMs) {
        throw new HttpError(410, "share_expired", "Share token is expired, revoked, or exhausted.");
      }

      // No awaits between the read and the write other than storage calls:
      // the Durable Object input gate keeps this read-modify-write atomic.
      // On the first consume the DO has no stored count yet, so it seeds from
      // the KV record's downloadCount: a share migrated from the old KV-only
      // accounting keeps its already-spent downloads instead of restarting at
      // zero and regaining its full quota. Afterwards the stored count wins.
      const stored = await this.state.storage.get<number>(COUNT_STORAGE_KEY);
      const current = stored ?? body.downloadCount;
      if (body.maxDownloads > 0 && current >= body.maxDownloads) {
        throw new HttpError(410, "share_expired", "Share token is expired, revoked, or exhausted.");
      }
      const updated = current + 1;
      await this.state.storage.put(COUNT_STORAGE_KEY, updated);

      const existingAlarm = await this.state.storage.getAlarm();
      if (existingAlarm === null) {
        await this.state.storage.setAlarm(body.expiresAtMs + COUNTER_RETENTION_MS);
      }

      return json({ count: updated });
    } catch (error) {
      if (error instanceof HttpError) {
        return apiError(error.status, error.code, error.message, error.details);
      }
      console.error("Unhandled share counter error:", error);
      return apiError(500, "internal_error", "Unexpected share counter error.");
    }
  }
}
