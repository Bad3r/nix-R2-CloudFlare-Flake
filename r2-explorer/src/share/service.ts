import { HttpError } from "../http";
import { getShareRecord, putShareRecord } from "../kv";
import type { Env, ShareRecord } from "../types";

/**
 * Check the KV-visible validity of a share record: not revoked, not past its
 * expiry, and not exhausted according to the (display-only, possibly lagging)
 * KV download count. Download caps are authoritatively enforced by
 * ShareCounterDurableObject; this check is the cheap fast path.
 */
export function shareStillValid(record: ShareRecord): boolean {
  if (record.revoked) {
    return false;
  }
  const expiry = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiry)) {
    return false;
  }
  if (Date.now() >= expiry) {
    return false;
  }
  if (record.maxDownloads > 0 && record.downloadCount >= record.maxDownloads) {
    return false;
  }
  return true;
}

function shareKvTtlSeconds(record: ShareRecord): number {
  const expiresAtEpoch = Math.floor(Date.parse(record.expiresAt) / 1000);
  const nowEpoch = Math.floor(Date.now() / 1000);
  return Math.max(60, expiresAtEpoch - nowEpoch);
}

async function consumeShareDownloadSlot(env: Env, record: ShareRecord): Promise<number> {
  const namespace = env.R2E_SHARE_COUNTERS;
  if (!namespace) {
    throw new HttpError(
      500,
      "share_counter_config_invalid",
      "Missing durable object binding R2E_SHARE_COUNTERS.",
    );
  }

  const stub = namespace.get(namespace.idFromName(record.tokenId));
  const response = await stub.fetch("https://share-counter/consume", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      tokenId: record.tokenId,
      maxDownloads: record.maxDownloads,
      expiresAtMs: Date.parse(record.expiresAt),
    }),
  });

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw new HttpError(500, "share_counter_error", "Share counter returned invalid JSON.", {
        status: response.status,
        parseError: String(error),
      });
    }
  }

  if (!response.ok) {
    const details =
      parsed && typeof parsed === "object" && "error" in parsed && (parsed as Record<string, unknown>).error &&
      typeof (parsed as Record<string, unknown>).error === "object"
        ? ((parsed as Record<string, unknown>).error as Record<string, unknown>)
        : null;
    const code = typeof details?.code === "string" ? details.code : "share_counter_error";
    const message =
      typeof details?.message === "string"
        ? details.message
        : `Share counter call failed with status ${response.status}.`;
    throw new HttpError(response.status, code, message, details?.details);
  }

  const count = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).count : undefined;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
    throw new HttpError(500, "share_counter_error", "Share counter returned an invalid count.");
  }
  return count;
}

/**
 * Account for one share download and return the record to serve.
 *
 * - Readonly mode performs no writes at all: the download is served but the
 *   counter is not advanced, so maxDownloads is intentionally not decremented
 *   while R2E_READONLY is enabled.
 * - Download-limited shares (maxDownloads > 0) consume a slot through
 *   ShareCounterDurableObject, whose per-token serialization makes the cap
 *   atomic even for concurrent downloads. The resulting count is written back
 *   to KV for display in /api/v2/share/list.
 * - Unlimited shares (maxDownloads = 0) skip the Durable Object hop and use a
 *   best-effort KV read-modify-write; that count is informational only and
 *   may undercount under concurrency, which is acceptable because there is no
 *   cap to enforce.
 */
export async function recordShareDownload(
  env: Env,
  record: ShareRecord,
  options: { readonly: boolean },
): Promise<ShareRecord> {
  if (options.readonly) {
    return record;
  }

  if (record.maxDownloads > 0) {
    const count = await consumeShareDownloadSlot(env, record);
    const updated: ShareRecord = { ...record, downloadCount: count };
    await putShareRecord(env.R2E_SHARES_KV, updated, shareKvTtlSeconds(updated));
    return updated;
  }

  const updated: ShareRecord = { ...record, downloadCount: record.downloadCount + 1 };
  await putShareRecord(env.R2E_SHARES_KV, updated, shareKvTtlSeconds(updated));
  return updated;
}

/**
 * Load a share record and reject missing, revoked, expired, and exhausted
 * tokens with the client-facing share_not_found / share_expired codes.
 */
export async function loadServableShare(env: Env, tokenId: string): Promise<ShareRecord> {
  const record = await getShareRecord(env.R2E_SHARES_KV, tokenId);
  if (!record) {
    throw new HttpError(404, "share_not_found", "Share token not found.");
  }
  if (!shareStillValid(record)) {
    throw new HttpError(410, "share_expired", "Share token is expired, revoked, or exhausted.");
  }
  return record;
}
