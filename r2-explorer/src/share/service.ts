import { HttpError } from "../http";
import { getShareRecord, putShareRecord } from "../kv";
import type { RangedObjectResult } from "../r2";
import type { Env, ShareRecord } from "../types";

/**
 * Range continuation grace period: a Range request starting past byte 0
 * counts as a free resume, not a new download, when it follows a counted
 * download start for the same token within this window. See the download
 * accounting section of docs/sharing.md.
 */
export const SHARE_DOWNLOAD_RESUME_WINDOW_MS = 15 * 60 * 1000;

/**
 * Check the KV-visible validity of a share record: not revoked and not past
 * its expiry. Download-cap exhaustion is deliberately not checked here: a
 * request that looks exhausted by the (display-only, possibly lagging) KV
 * download count may still be an in-window Range continuation of the very
 * download that reached the cap, which must reach the authoritative
 * ShareCounterDurableObject to be decided, not be rejected by this cheap
 * fast path. Revocation and expiry have no such exception, so they stay a
 * safe, cheap short-circuit here.
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
  return true;
}

function shareKvTtlSeconds(record: ShareRecord): number {
  const expiresAtEpoch = Math.floor(Date.parse(record.expiresAt) / 1000);
  const nowEpoch = Math.floor(Date.now() / 1000);
  return Math.max(60, expiresAtEpoch - nowEpoch);
}

/**
 * POST a request to the token's counter Durable Object and parse its JSON
 * response, translating a non-2xx status into an HttpError carrying the
 * counter's own error code/message when present.
 */
async function callShareCounter(
  env: Env,
  tokenId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const namespace = env.R2E_SHARE_COUNTERS;
  if (!namespace) {
    throw new HttpError(
      500,
      "share_counter_config_invalid",
      "Missing durable object binding R2E_SHARE_COUNTERS.",
    );
  }

  const stub = namespace.get(namespace.idFromName(tokenId));
  const response = await stub.fetch(`https://share-counter${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
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

  if (!parsed || typeof parsed !== "object") {
    throw new HttpError(500, "share_counter_error", "Share counter returned an invalid response.");
  }
  return parsed as Record<string, unknown>;
}

type ConsumeOutcome = { allowed: true; consumed: boolean; count: number } | { allowed: false };

/**
 * Ask the token's counter Durable Object to account for a download: a fresh
 * start or an out-of-window continuation consumes a slot (subject to
 * maxDownloads); a continuation inside the resume window is free. A 410 from
 * the counter (revoked, expired, or exhausted) comes back as `allowed:
 * false` instead of throwing, so the caller can cancel the unread object
 * body before answering.
 */
async function consumeShareDownloadSlot(
  env: Env,
  record: ShareRecord,
  isContinuation: boolean,
): Promise<ConsumeOutcome> {
  try {
    const parsed = await callShareCounter(env, record.tokenId, "/consume", {
      tokenId: record.tokenId,
      maxDownloads: record.maxDownloads,
      expiresAtMs: Date.parse(record.expiresAt),
      // Seed value for a share migrated from KV-only accounting: the DO uses
      // it only on its very first consume, then its own stored count wins.
      downloadCount: record.downloadCount,
      isContinuation,
      resumeWindowMs: SHARE_DOWNLOAD_RESUME_WINDOW_MS,
    });
    const count = parsed.count;
    const consumed = parsed.consumed;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      throw new HttpError(500, "share_counter_error", "Share counter returned an invalid count.");
    }
    if (typeof consumed !== "boolean") {
      throw new HttpError(500, "share_counter_error", "Share counter returned an invalid consumed flag.");
    }
    return { allowed: true, consumed, count };
  } catch (error) {
    if (error instanceof HttpError && error.status === 410) {
      return { allowed: false };
    }
    throw error;
  }
}

/**
 * Read-only, non-mutating check of the counter's authoritative revoked and
 * exhausted state, for requests that must never write (readonly mode, HEAD,
 * and GET outcomes with no body: 304/412/416). `isContinuation` carries the
 * same resume-window exemption /consume grants a continuation; see
 * determineIsContinuation for how it is derived when there is no served
 * R2Range to read.
 */
async function checkShareCounterStatus(
  env: Env,
  record: ShareRecord,
  isContinuation: boolean,
): Promise<{ revoked: boolean; exhausted: boolean }> {
  const parsed = await callShareCounter(env, record.tokenId, "/status", {
    tokenId: record.tokenId,
    maxDownloads: record.maxDownloads,
    expiresAtMs: Date.parse(record.expiresAt),
    downloadCount: record.downloadCount,
    isContinuation,
    resumeWindowMs: SHARE_DOWNLOAD_RESUME_WINDOW_MS,
  });
  if (typeof parsed.revoked !== "boolean" || typeof parsed.exhausted !== "boolean") {
    throw new HttpError(500, "share_counter_error", "Share counter returned an invalid status.");
  }
  return { revoked: parsed.revoked, exhausted: parsed.exhausted };
}

/**
 * Record revocation in the token's counter Durable Object before updating
 * KV: the DO is a single global instance with no propagation delay, so if
 * the KV write below then fails, every future download is already refused
 * (fails closed), and retrying this whole call is safe since both writes
 * are idempotent.
 */
export async function revokeShareCounter(env: Env, record: ShareRecord): Promise<void> {
  await callShareCounter(env, record.tokenId, "/revoke", {
    tokenId: record.tokenId,
    expiresAtMs: Date.parse(record.expiresAt),
  });
}

/** Whether an "ok" range result serves its first byte at offset 0 (a download start, not a resume). */
function servesFromByteZero(object: R2ObjectBody): boolean {
  const range = object.range;
  if (!range) {
    return true;
  }
  // workerd reports { offset, length, suffix: undefined }: test the values, a key check is always true.
  const suffix = "suffix" in range ? range.suffix : undefined;
  if (typeof suffix === "number") {
    return object.size - suffix <= 0;
  }
  const offset = "offset" in range ? range.offset : undefined;
  return (offset ?? 0) === 0;
}

/**
 * Parse a Range header the same way r2.ts's getObjectForRead does and decide
 * whether it describes bytes starting past offset 0 (a continuation shape),
 * given the object's total size (needed to resolve a suffix range). Used for
 * HEAD and no-body outcomes (304/412/416), which have no served R2Range of
 * their own for servesFromByteZero to read: HEAD never honors Range in what
 * it serves, but a Range header on the request still describes what a GET
 * carrying the same headers would do, which is the question being answered.
 * A header this cannot parse as a single well-formed range is not a
 * continuation shape, matching R2's own full-content fallback for those.
 */
function isContinuationRangeHeader(rangeHeaderValue: string | null, size: number): boolean {
  if (!rangeHeaderValue) {
    return false;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeaderValue.trim());
  if (!match) {
    return false;
  }
  const [, startText, endText] = match;
  if (startText === "") {
    if (endText === "") {
      return false;
    }
    const suffix = Number.parseInt(endText, 10);
    return Number.isFinite(suffix) && suffix > 0 && size - suffix > 0;
  }
  const offset = Number.parseInt(startText, 10);
  return Number.isFinite(offset) && offset > 0;
}

/**
 * Decide whether this request is a continuation, the question that decides
 * both whether /consume must spend a slot and whether a non-consuming
 * /status check grants the resume-window exemption. A non-HEAD "ok" result
 * reflects the range R2 actually resolved (servesFromByteZero). HEAD always
 * calls getObjectForRead with allowRange: false, so its "ok" result always
 * describes the full object regardless of the client's Range header; no-body
 * outcomes (304/412/416) likewise have no served range reflecting it. Both
 * cases answer the same question from the request's own Range header
 * instead, per "would a GET carrying these same headers be refused".
 */
function determineIsContinuation(result: RangedObjectResult, requestHeaders: Headers, isHead: boolean): boolean {
  if (!isHead && result.kind === "ok") {
    return !servesFromByteZero(result.object);
  }
  const size = result.kind === "unsatisfiable_range" ? result.size : result.object.size;
  return isContinuationRangeHeader(requestHeaders.get("range"), size);
}

/**
 * Cancel an unread object body before answering a refused download. Test
 * doubles model R2ObjectBody.body as a plain byte array with no cancel();
 * skip rather than throw in that case.
 */
async function cancelUnconsumedBody(result: RangedObjectResult): Promise<void> {
  if (result.kind !== "ok") {
    return;
  }
  const body = result.object.body as unknown as { cancel?: () => Promise<void> };
  if (typeof body.cancel !== "function") {
    return;
  }
  try {
    await body.cancel();
  } catch (error) {
    console.error("Failed to cancel unread share object body after a refused download:", error);
  }
}

/**
 * Account for one /share/:token request against the record's counted state,
 * throwing share_expired (410) if it must be refused. Never throws for a
 * request that goes on to serve a response.
 *
 * - Readonly mode, HEAD, and any GET outcome with no body (304/412/416)
 *   never consume a slot or write anything (KV or counter storage); all
 *   three are authoritatively checked against the counter's read-only
 *   /status instead, which reports the same revoked/exhausted state a
 *   consuming request would. Readonly's "no writes" invariant holds because
 *   /status itself never writes, so maxDownloads decrementing is skipped
 *   while R2E_READONLY is enabled, not the revocation/exhaustion checks
 *   themselves (see docs/operators/readonly-maintenance.md).
 * - A GET serving a body from byte 0 is a download start and a GET serving a
 *   body from a later offset is a continuation; both go through the
 *   counter's /consume, which decides whether the continuation is free (see
 *   ShareCounterDurableObject). A successful consume updates the KV record's
 *   downloadCount for /api/v2/share/list; a free continuation changes
 *   nothing.
 * - "Continuation" for the read-only /status path (readonly, HEAD, no-body
 *   outcomes) is decided from the request's own Range header rather than a
 *   served R2Range, per determineIsContinuation: "would a GET carrying
 *   these same headers be refused". A HEAD or conditional request with no
 *   Range header is a start shape and gets no resume-window exemption; one
 *   carrying a continuation-shaped Range header does, even though HEAD
 *   never honors Range in what it serves.
 */
export async function recordShareDownload(
  env: Env,
  record: ShareRecord,
  result: RangedObjectResult,
  requestHeaders: Headers,
  options: { readonly: boolean; isHead: boolean },
): Promise<void> {
  const isContinuation = determineIsContinuation(result, requestHeaders, options.isHead);

  if (options.readonly || options.isHead || result.kind !== "ok") {
    const status = await checkShareCounterStatus(env, record, isContinuation);
    if (status.revoked || status.exhausted) {
      await cancelUnconsumedBody(result);
      throw new HttpError(410, "share_expired", "Share token is expired, revoked, or exhausted.");
    }
    return;
  }

  const outcome = await consumeShareDownloadSlot(env, record, isContinuation);
  if (!outcome.allowed) {
    await cancelUnconsumedBody(result);
    throw new HttpError(410, "share_expired", "Share token is expired, revoked, or exhausted.");
  }
  if (!outcome.consumed) {
    return;
  }
  const updated: ShareRecord = { ...record, downloadCount: outcome.count };
  await putShareRecord(env.R2E_SHARES_KV, updated, shareKvTtlSeconds(updated));
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
