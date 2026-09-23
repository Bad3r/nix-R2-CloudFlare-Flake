import { apiError, HttpError, json, parseJsonText } from "./http";
import { abortMultipartUpload } from "./r2";
import type { Env } from "./types";

type SessionStatus = "init" | "active" | "staged" | "completed" | "aborted" | "expired";

type SignedPartRecord = {
  partNumber: number;
  issuedAt: string;
  contentLength: number;
  contentMd5: string | null;
};

type SessionStorageRecord = {
  sessionId: string;
  ownerId: string;
  bucket: string;
  uploadId: string;
  /** Final key the upload is promoted to after validation. */
  objectKey: string;
  /**
   * Key the multipart upload is assembled under (.r2e-staging/...). Legacy
   * records written before staged completion existed default this to
   * objectKey, preserving their original direct-to-target behavior.
   */
  stagingKey: string;
  filename: string;
  contentType: string;
  declaredSize: number;
  sha256: string | null;
  prefix: string;
  maxParts: number;
  maxFileBytes: number;
  partSizeBytes: number;
  createdAt: string;
  expiresAt: string;
  status: SessionStatus;
  completedAt: string | null;
  abortedAt: string | null;
  signedParts: Record<string, SignedPartRecord>;
  /** Whether this session may overwrite a pre-existing object at objectKey. */
  overwrite: boolean;
  /**
   * Expiry of the current promotion attempt's exclusive lease, or null when no
   * promotion is in flight. Guards the existence-check/soft-delete/promote
   * sequence against a second, concurrent or retried /complete interleaving
   * with it.
   */
  promotionLeaseExpiresAt: string | null;
  /**
   * Fencing token issued with the current promotion lease. Only the holder
   * can renew or release the lease or record completion, so a promoter whose
   * lease lapsed and was re-acquired by a retry can no longer mutate the
   * session, however long its own copy loop keeps running.
   */
  promotionLeaseToken: string | null;
};

type CreateSessionRequest = {
  session: SessionStorageRecord;
  maxConcurrentUploads: number;
};

type SessionRequest = {
  sessionId: string;
  requireActive?: boolean;
};

type UpdateSessionRequest = {
  sessionId: string;
  uploadId: string;
  /** Lease holder's fencing token; required by renew, release and complete while a lease is held. */
  promotionLeaseToken?: string;
};

type RecordSignedPartRequest = {
  sessionId: string;
  uploadId: string;
  partNumber: number;
  contentLength: number;
  contentMd5?: string;
};

type SessionResponse = {
  session: SessionStorageRecord;
};

const SESSION_PREFIX = "session:";
const EXPIRED_RETENTION_MS = 24 * 60 * 60 * 1000;
/**
 * Bounds how long a crashed promotion invocation can block a retry. A live
 * promoter renews the lease (see /renew-promotion-lease) before each write of
 * its copy loop, so this only needs to cover the gap between two writes of a
 * healthy promotion, not the whole promotion; a promoter that stops renewing
 * has crashed and loses the lease to the next retry after this window.
 */
export const PROMOTION_LEASE_MS = 15 * 60 * 1000;

function storageKey(sessionId: string): string {
  return `${SESSION_PREFIX}${sessionId}`;
}

function normalizeOwnerKey(ownerId: string): string {
  const trimmed = ownerId.trim();
  if (trimmed.length === 0) {
    throw new HttpError(400, "owner_required", "Upload session owner is required.");
  }
  // OAuth principals are email-like where possible; enforce canonical lowercase
  // form so equivalent identifiers cannot bypass session ownership checks.
  return trimmed.toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "validation_error", "Request payload must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, "validation_error", `${field} must be a non-empty string.`);
  }
  return value;
}

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return asString(value, field);
}

function asOptionalBoolean(value: unknown, field: string): boolean {
  if (value === undefined || value === null) {
    // Sessions written before the overwrite flag existed default to false,
    // preserving the pre-existing no-overwrite behavior.
    return false;
  }
  if (typeof value !== "boolean") {
    throw new HttpError(400, "validation_error", `${field} must be a boolean.`);
  }
  return value;
}

function asStringAllowEmpty(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "validation_error", `${field} must be a string.`);
  }
  return value;
}

function asNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new HttpError(400, "validation_error", `${field} must be a non-negative integer.`);
  }
  return value;
}

function asPositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, "validation_error", `${field} must be a positive integer.`);
  }
  return value;
}

function asNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  return asString(value, field);
}

function asOptionalNullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    // Sessions written before this field existed default to null (no lease).
    return null;
  }
  return asString(value, field);
}

function parseSignedPartRecord(value: unknown, key: string): SignedPartRecord {
  const record = asRecord(value);
  const partNumber = asPositiveInt(record.partNumber, `session.signedParts.${key}.partNumber`);
  const issuedAt = asString(record.issuedAt, `session.signedParts.${key}.issuedAt`);
  const contentLength = asPositiveInt(record.contentLength, `session.signedParts.${key}.contentLength`);
  const contentMd5Raw = record.contentMd5;
  const contentMd5 =
    contentMd5Raw === undefined || contentMd5Raw === null
      ? null
      : asString(contentMd5Raw, `session.signedParts.${key}.contentMd5`);
  return {
    partNumber,
    issuedAt,
    contentLength,
    contentMd5,
  };
}

function parseSignedPartsMap(value: unknown): Record<string, SignedPartRecord> {
  if (value === undefined || value === null) {
    return {};
  }
  const raw = asRecord(value);
  const entries = Object.entries(raw);
  const parsed: Record<string, SignedPartRecord> = {};
  for (const [key, record] of entries) {
    parsed[key] = parseSignedPartRecord(record, key);
  }
  return parsed;
}

function parseSessionStatus(value: unknown): SessionStatus {
  const status = asString(value, "session.status");
  if (
    status === "init" ||
    status === "active" ||
    status === "staged" ||
    status === "completed" ||
    status === "aborted" ||
    status === "expired"
  ) {
    return status;
  }
  throw new HttpError(
    400,
    "validation_error",
    "session.status must be init, active, staged, completed, aborted, or expired.",
  );
}

function parseSessionRecord(input: unknown): SessionStorageRecord {
  const record = asRecord(input);
  const objectKey = asString(record.objectKey, "session.objectKey");
  // Sessions created before staged completion have no stagingKey; treat their
  // objectKey as the staging location so legacy in-flight uploads keep working.
  const stagingKey =
    record.stagingKey === undefined || record.stagingKey === null
      ? objectKey
      : asString(record.stagingKey, "session.stagingKey");

  return {
    sessionId: asString(record.sessionId, "session.sessionId"),
    ownerId: asString(record.ownerId, "session.ownerId"),
    bucket: asString(record.bucket, "session.bucket"),
    uploadId: asString(record.uploadId, "session.uploadId"),
    objectKey,
    stagingKey,
    filename: asString(record.filename, "session.filename"),
    contentType: asString(record.contentType, "session.contentType"),
    declaredSize: asPositiveInt(record.declaredSize, "session.declaredSize"),
    sha256: record.sha256 === null || record.sha256 === undefined ? null : asString(record.sha256, "session.sha256"),
    prefix: asStringAllowEmpty(record.prefix, "session.prefix"),
    maxParts: asPositiveInt(record.maxParts, "session.maxParts"),
    maxFileBytes: asNonNegativeInt(record.maxFileBytes, "session.maxFileBytes"),
    partSizeBytes: asPositiveInt(record.partSizeBytes, "session.partSizeBytes"),
    createdAt: asString(record.createdAt, "session.createdAt"),
    expiresAt: asString(record.expiresAt, "session.expiresAt"),
    status: parseSessionStatus(record.status),
    completedAt: asNullableString(record.completedAt, "session.completedAt"),
    abortedAt: asNullableString(record.abortedAt, "session.abortedAt"),
    signedParts: parseSignedPartsMap(record.signedParts),
    overwrite: asOptionalBoolean(record.overwrite, "session.overwrite"),
    promotionLeaseExpiresAt: asOptionalNullableString(record.promotionLeaseExpiresAt, "session.promotionLeaseExpiresAt"),
    promotionLeaseToken: asOptionalNullableString(record.promotionLeaseToken, "session.promotionLeaseToken"),
  };
}

function parseCreateRequest(input: unknown): CreateSessionRequest {
  const payload = asRecord(input);
  return {
    session: parseSessionRecord(payload.session),
    maxConcurrentUploads: asNonNegativeInt(payload.maxConcurrentUploads, "maxConcurrentUploads"),
  };
}

function parseSessionRequest(input: unknown): SessionRequest {
  const payload = asRecord(input);
  const request: SessionRequest = {
    sessionId: asString(payload.sessionId, "sessionId"),
  };
  if (payload.requireActive !== undefined) {
    if (typeof payload.requireActive !== "boolean") {
      throw new HttpError(400, "validation_error", "requireActive must be a boolean when provided.");
    }
    request.requireActive = payload.requireActive;
  }
  return request;
}

function parseUpdateRequest(input: unknown): UpdateSessionRequest {
  const payload = asRecord(input);
  return {
    sessionId: asString(payload.sessionId, "sessionId"),
    uploadId: asString(payload.uploadId, "uploadId"),
    promotionLeaseToken: asOptionalString(payload.promotionLeaseToken, "promotionLeaseToken"),
  };
}

function parseRecordSignedPartRequest(input: unknown): RecordSignedPartRequest {
  const payload = asRecord(input);
  return {
    sessionId: asString(payload.sessionId, "sessionId"),
    uploadId: asString(payload.uploadId, "uploadId"),
    partNumber: asPositiveInt(payload.partNumber, "partNumber"),
    contentLength: asPositiveInt(payload.contentLength, "contentLength"),
    contentMd5: asOptionalString(payload.contentMd5, "contentMd5"),
  };
}

function assertIsoTimestamp(value: string, field: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, "validation_error", `${field} must be a valid ISO-8601 timestamp.`);
  }
}

function hasLivePromotionLease(session: SessionStorageRecord, nowMs: number): boolean {
  const leaseExpiresMs = session.promotionLeaseExpiresAt ? Date.parse(session.promotionLeaseExpiresAt) : Number.NaN;
  return Number.isFinite(leaseExpiresMs) && leaseExpiresMs > nowMs;
}

/**
 * A live promotion lease defers expiry: reclaiming the staged object while
 * its promoter is still copying it would break that promotion, and the lease
 * itself already extends expiresAt (see deferExpiryForLease), so this only
 * matters for a lease acquired before that extension was written.
 */
function isExpired(session: SessionStorageRecord, nowMs: number): boolean {
  return Date.parse(session.expiresAt) <= nowMs && !hasLivePromotionLease(session, nowMs);
}

/**
 * Keep the session alive for one more lease window past the lease itself, so
 * a promoter that crashes right before its lease lapses still leaves the
 * retrying client a full window to resume from the staged object before the
 * alarm reclaims it.
 */
function deferExpiryForLease(session: SessionStorageRecord, leaseExpiresAt: string): string {
  const deferredMs = Date.parse(leaseExpiresAt) + PROMOTION_LEASE_MS;
  return Date.parse(session.expiresAt) >= deferredMs ? session.expiresAt : new Date(deferredMs).toISOString();
}

function isInFlight(session: SessionStorageRecord): boolean {
  return session.status === "init" || session.status === "active" || session.status === "staged";
}

async function callSessionStore<T>(
  env: Env,
  ownerId: string,
  path: string,
  payload: unknown,
): Promise<T> {
  const namespace = env.R2E_UPLOAD_SESSIONS;
  if (!namespace) {
    throw new HttpError(
      500,
      "upload_sessions_config_invalid",
      "Missing durable object binding R2E_UPLOAD_SESSIONS.",
    );
  }

  const ownerKey = normalizeOwnerKey(ownerId);
  const stub = namespace.get(namespace.idFromName(ownerKey));
  const response = await stub.fetch("https://upload-sessions" + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw new HttpError(500, "upload_session_error", "Upload session store returned invalid JSON.", {
        path,
        status: response.status,
        parseError: String(error),
      });
    }
  }

  if (!response.ok) {
    const details =
      parsed &&
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      (parsed as Record<string, unknown>).error &&
      typeof (parsed as Record<string, unknown>).error === "object"
        ? ((parsed as Record<string, unknown>).error as Record<string, unknown>)
        : null;

    const code = typeof details?.code === "string" ? details.code : "upload_session_error";
    const message =
      typeof details?.message === "string"
        ? details.message
        : `Upload session store call failed for ${path} with status ${response.status}.`;
    throw new HttpError(response.status, code, message, details?.details);
  }

  return parsed as T;
}

function assertSessionOwner(session: SessionStorageRecord, ownerId: string): void {
  if (normalizeOwnerKey(session.ownerId) !== normalizeOwnerKey(ownerId)) {
    throw new HttpError(409, "upload_session_owner_mismatch", "Upload session owner does not match request actor.");
  }
}

/** Create an upload session owned by ownerId, enforcing the concurrency cap. */
export async function createUploadSession(
  env: Env,
  ownerId: string,
  payload: CreateSessionRequest,
): Promise<SessionStorageRecord> {
  const result = await callSessionStore<SessionResponse>(env, ownerId, "/create", payload);
  const session = parseSessionRecord(result.session);
  assertSessionOwner(session, ownerId);
  return session;
}

/** Load an upload session, optionally requiring it to still be active. */
export async function requireUploadSession(
  env: Env,
  ownerId: string,
  payload: SessionRequest,
): Promise<SessionStorageRecord> {
  const result = await callSessionStore<SessionResponse>(env, ownerId, "/get", payload);
  const session = parseSessionRecord(result.session);
  assertSessionOwner(session, ownerId);
  return session;
}

/**
 * Atomically transition the session to staged (if not already) and acquire an
 * exclusive lease on promoting it, so a second, concurrent or retried
 * /complete cannot interleave its own existence-check/soft-delete/promote
 * sequence with this one. The Durable Object's single-threaded execution
 * serializes the read-check-write across concurrent callers, making the
 * check-and-acquire atomic. Rejects with upload_promotion_in_progress
 * (details.retryAfterSeconds) when a live lease already exists.
 */
export async function acquirePromotionLease(
  env: Env,
  ownerId: string,
  payload: UpdateSessionRequest,
): Promise<SessionStorageRecord> {
  const result = await callSessionStore<SessionResponse>(env, ownerId, "/acquire-promotion-lease", payload);
  const session = parseSessionRecord(result.session);
  assertSessionOwner(session, ownerId);
  return session;
}

/**
 * Release a held promotion lease so an immediate retry after a promotion
 * failure does not have to wait out the lease TTL. Idempotent: releasing an
 * already-released (or never-acquired) lease is a no-op.
 */
export async function releasePromotionLease(
  env: Env,
  ownerId: string,
  payload: UpdateSessionRequest,
): Promise<SessionStorageRecord> {
  const result = await callSessionStore<SessionResponse>(env, ownerId, "/release-promotion-lease", payload);
  const session = parseSessionRecord(result.session);
  assertSessionOwner(session, ownerId);
  return session;
}

/**
 * Extend the held promotion lease by another PROMOTION_LEASE_MS. Rejects with
 * upload_promotion_in_progress (details.reason "lease_lost") when a retry has
 * taken the lease over, which is the caller's signal to stop writing.
 */
export async function renewPromotionLease(
  env: Env,
  ownerId: string,
  payload: UpdateSessionRequest,
): Promise<SessionStorageRecord> {
  const result = await callSessionStore<SessionResponse>(env, ownerId, "/renew-promotion-lease", payload);
  const session = parseSessionRecord(result.session);
  assertSessionOwner(session, ownerId);
  return session;
}

/**
 * Transition an active or staged upload session to completed. The store
 * deletes the staged object itself once the transition is durable.
 */
export async function markUploadSessionCompleted(
  env: Env,
  ownerId: string,
  payload: UpdateSessionRequest,
): Promise<SessionStorageRecord> {
  const result = await callSessionStore<SessionResponse>(env, ownerId, "/complete", payload);
  const session = parseSessionRecord(result.session);
  assertSessionOwner(session, ownerId);
  return session;
}

/** Transition an upload session to aborted (idempotent for aborted sessions). */
export async function markUploadSessionAborted(
  env: Env,
  ownerId: string,
  payload: UpdateSessionRequest,
): Promise<SessionStorageRecord> {
  const result = await callSessionStore<SessionResponse>(env, ownerId, "/abort", payload);
  const session = parseSessionRecord(result.session);
  assertSessionOwner(session, ownerId);
  return session;
}

/** Record a signed part issuance on an active upload session. */
export async function recordUploadSessionSignedPart(
  env: Env,
  ownerId: string,
  payload: RecordSignedPartRequest,
): Promise<SessionStorageRecord> {
  const result = await callSessionStore<SessionResponse>(env, ownerId, "/record-signed-part", payload);
  const session = parseSessionRecord(result.session);
  assertSessionOwner(session, ownerId);
  return session;
}

export class UploadSessionDurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  /**
   * Throw upload_promotion_in_progress (with retryAfterSeconds) when the
   * session holds an unexpired promotion lease. Shared by lease acquisition
   * and abort: both must refuse to proceed while a promotion is in flight,
   * neither may write anything when this throws.
   */
  private assertNoLivePromotionLease(session: SessionStorageRecord, sessionId: string): void {
    const nowMs = Date.now();
    if (hasLivePromotionLease(session, nowMs)) {
      throw new HttpError(409, "upload_promotion_in_progress", "Another request is already promoting this upload.", {
        sessionId,
        retryAfterSeconds: Math.max(1, Math.ceil((Date.parse(session.promotionLeaseExpiresAt!) - nowMs) / 1000)),
      });
    }
  }

  /**
   * Fence renew, release and complete on the lease token: a caller whose
   * lease lapsed and was re-acquired by a retry presents a stale token and is
   * told to wait like any other bystander, so it cannot release the retry's
   * lease or record completion of a promotion it no longer owns. Sessions
   * that never acquired a lease (legacy direct-to-target uploads) carry no
   * token and are not fenced; neither is a released lease, which stays safe
   * only because /renew-promotion-lease refuses one (see there).
   */
  private assertLeaseHolder(session: SessionStorageRecord, body: UpdateSessionRequest): void {
    if (session.promotionLeaseToken === null || body.promotionLeaseToken === session.promotionLeaseToken) {
      return;
    }
    const nowMs = Date.now();
    const retryAfterSeconds = hasLivePromotionLease(session, nowMs)
      ? Math.max(1, Math.ceil((Date.parse(session.promotionLeaseExpiresAt!) - nowMs) / 1000))
      : 1;
    throw new HttpError(409, "upload_promotion_in_progress", "Another request took over promoting this upload.", {
      sessionId: body.sessionId,
      reason: "lease_lost",
      retryAfterSeconds,
    });
  }

  /**
   * Delete the staged object left by a session, never the target key itself:
   * legacy sessions staged directly at objectKey, where the key may hold a
   * previously stored object. Failures are logged; the object sits under the
   * reserved staging prefix and the next expiry pass retries the delete.
   */
  private async reclaimStagedObject(session: SessionStorageRecord): Promise<void> {
    const stagingKey = session.stagingKey ?? session.objectKey;
    if (stagingKey === session.objectKey) {
      return;
    }
    try {
      await this.env.FILES_BUCKET.delete(stagingKey);
    } catch (error) {
      console.error(`Failed to delete staged object ${stagingKey} for session ${session.sessionId}:`, error);
    }
  }

  /**
   * Release the R2 resources held by an expired in-flight session: abort the
   * multipart upload and delete any staged object left behind by a partially
   * completed request. Failures are logged and do not stop pruning; R2's
   * bucket lifecycle rules for incomplete multipart uploads are the backstop
   * for aborts that keep failing.
   */
  private async releaseExpiredUploadResources(session: SessionStorageRecord): Promise<void> {
    const stagingKey = session.stagingKey ?? session.objectKey;
    // A staged session already ran completeMultipartUpload successfully, so
    // R2 has consumed the uploadId; abort would always fail. Skip straight to
    // reclaiming the staged object instead of logging a guaranteed failure.
    if (session.status !== "staged") {
      try {
        await abortMultipartUpload(this.env.FILES_BUCKET, stagingKey, session.uploadId);
      } catch (error) {
        console.error(
          `Failed to abort expired multipart upload ${session.uploadId} for session ${session.sessionId}:`,
          error,
        );
      }
    }
    await this.reclaimStagedObject(session);
  }

  private async pruneExpiredSessions(nowMs: number): Promise<void> {
    const listing = await this.state.storage.list<SessionStorageRecord>({ prefix: SESSION_PREFIX });
    const updates = new Map<string, SessionStorageRecord>();
    const deletes: string[] = [];

    for (const [key, value] of listing.entries()) {
      if (!isExpired(value, nowMs)) {
        continue;
      }

      if (value.status !== "expired") {
        if (isInFlight(value)) {
          await this.releaseExpiredUploadResources(value);
        } else if (value.status === "completed" || value.status === "aborted") {
          // /complete deletes the staged object after recording completion and
          // the abort paths delete it after recording the abort; this catches
          // a delete that failed or a Worker evicted in between.
          await this.reclaimStagedObject(value);
        }
        updates.set(key, {
          ...value,
          status: "expired",
        });
        continue;
      }

      if (Date.parse(value.expiresAt) + EXPIRED_RETENTION_MS <= nowMs) {
        deletes.push(key);
      }
    }

    if (updates.size > 0) {
      await this.state.storage.put(Object.fromEntries(updates));
    }
    if (deletes.length > 0) {
      await this.state.storage.delete(deletes);
    }
  }

  /**
   * Schedule the alarm for the next session lifecycle event: the earliest
   * pending expiry, or the earliest retention deletion for already-expired
   * records. Without this alarm nothing would ever invoke pruning, so
   * abandoned uploads would hold R2 multipart state forever.
   */
  private async scheduleNextAlarm(): Promise<void> {
    const listing = await this.state.storage.list<SessionStorageRecord>({ prefix: SESSION_PREFIX });
    let nextEventMs: number | null = null;
    for (const value of listing.values()) {
      const expiresAtMs = Date.parse(value.expiresAt);
      if (!Number.isFinite(expiresAtMs)) {
        continue;
      }
      const eventMs = value.status === "expired" ? expiresAtMs + EXPIRED_RETENTION_MS : expiresAtMs;
      if (nextEventMs === null || eventMs < nextEventMs) {
        nextEventMs = eventMs;
      }
    }

    if (nextEventMs === null) {
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.setAlarm(nextEventMs);
  }

  /** Alarm handler: prune expired sessions, then schedule the next event. */
  async alarm(): Promise<void> {
    await this.pruneExpiredSessions(Date.now());
    await this.scheduleNextAlarm();
  }

  private async loadSession(sessionId: string): Promise<SessionStorageRecord> {
    const key = storageKey(sessionId);
    const session = await this.state.storage.get<SessionStorageRecord>(key);
    if (!session) {
      throw new HttpError(404, "upload_session_not_found", "Upload session not found.", {
        sessionId,
      });
    }

    assertIsoTimestamp(session.expiresAt, "session.expiresAt");
    const nowMs = Date.now();
    if (isExpired(session, nowMs)) {
      if (session.status !== "expired" && isInFlight(session)) {
        await this.releaseExpiredUploadResources(session);
      }
      const updated: SessionStorageRecord = {
        ...session,
        status: "expired",
      };
      await this.state.storage.put(key, updated);
      throw new HttpError(410, "upload_session_expired", "Upload session has expired.", {
        sessionId,
      });
    }

    return session;
  }

  private async activeSessionCount(nowMs: number): Promise<number> {
    const listing = await this.state.storage.list<SessionStorageRecord>({ prefix: SESSION_PREFIX });
    let count = 0;
    for (const value of listing.values()) {
      // A staged session (mid-promotion) still holds a staged object and a
      // slot against the per-owner cap just as much as an active one does.
      if (isInFlight(value) && !isExpired(value, nowMs)) {
        count += 1;
      }
    }
    return count;
  }

  private async activeSessionForObjectKey(nowMs: number, objectKey: string): Promise<SessionStorageRecord | null> {
    const listing = await this.state.storage.list<SessionStorageRecord>({ prefix: SESSION_PREFIX });
    for (const value of listing.values()) {
      // Must match "staged" too: that is exactly the window where this
      // session is running its own existence-check/backup/promote sequence
      // against objectKey, and a second session promoting the same key
      // concurrently is the race RW-2 closes.
      if (isInFlight(value) && !isExpired(value, nowMs) && value.objectKey === objectKey) {
        return value;
      }
    }
    return null;
  }

  private createSessionResponse(session: SessionStorageRecord): Response {
    return json({ session });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const method = request.method.toUpperCase();
      if (method !== "POST") {
        return apiError(405, "method_not_allowed", "Only POST is supported for upload session store.");
      }

      const url = new URL(request.url);
      const rawBody = await request.text();

      if (url.pathname === "/create") {
        const body = parseCreateRequest(parseJsonText(rawBody));
        assertIsoTimestamp(body.session.createdAt, "session.createdAt");
        assertIsoTimestamp(body.session.expiresAt, "session.expiresAt");

        const nowMs = Date.now();
        await this.pruneExpiredSessions(nowMs);

        if (body.maxConcurrentUploads > 0) {
          const activeCount = await this.activeSessionCount(nowMs);
          if (activeCount >= body.maxConcurrentUploads) {
            throw new HttpError(
              429,
              "upload_concurrency_limit",
              "Maximum concurrent uploads reached for this user.",
              {
                activeCount,
                limit: body.maxConcurrentUploads,
              },
            );
          }
        }

        const key = storageKey(body.session.sessionId);
        const existing = await this.state.storage.get<SessionStorageRecord>(key);
        if (existing) {
          throw new HttpError(409, "upload_session_exists", "Upload session already exists.", {
            sessionId: body.session.sessionId,
          });
        }

        const keyConflict = await this.activeSessionForObjectKey(nowMs, body.session.objectKey);
        if (keyConflict) {
          throw new HttpError(409, "upload_object_key_in_use", "An active upload session already targets this key.", {
            objectKey: body.session.objectKey,
            sessionId: keyConflict.sessionId,
          });
        }

        if (body.session.status !== "init" && body.session.status !== "active") {
          throw new HttpError(
            409,
            "upload_session_invalid_state",
            "New upload sessions must be created in init or active state.",
            {
              status: body.session.status,
            },
          );
        }

        const activeSession: SessionStorageRecord = {
          ...body.session,
          status: "active",
        };
        await this.state.storage.put(key, activeSession);
        await this.scheduleNextAlarm();
        return this.createSessionResponse(activeSession);
      }

      if (url.pathname === "/get") {
        const body = parseSessionRequest(parseJsonText(rawBody));
        const session = await this.loadSession(body.sessionId);
        if (body.requireActive && session.status !== "active") {
          throw new HttpError(
            409,
            "upload_session_not_active",
            "Upload session is not active.",
            {
              sessionId: body.sessionId,
              status: session.status,
            },
          );
        }
        return this.createSessionResponse(session);
      }

      if (url.pathname === "/record-signed-part") {
        const body = parseRecordSignedPartRequest(parseJsonText(rawBody));
        const session = await this.loadSession(body.sessionId);

        if (session.uploadId !== body.uploadId) {
          throw new HttpError(409, "upload_session_mismatch", "Upload session uploadId mismatch.", {
            sessionId: body.sessionId,
          });
        }

        if (session.status !== "active") {
          throw new HttpError(409, "upload_session_not_active", "Upload session is not active.", {
            sessionId: body.sessionId,
            status: session.status,
          });
        }

        const signedPartKey = String(body.partNumber);
        const updated: SessionStorageRecord = {
          ...session,
          signedParts: {
            ...session.signedParts,
            [signedPartKey]: {
              partNumber: body.partNumber,
              issuedAt: new Date().toISOString(),
              contentLength: body.contentLength,
              contentMd5: body.contentMd5 ?? null,
            },
          },
        };
        await this.state.storage.put(storageKey(body.sessionId), updated);
        return this.createSessionResponse(updated);
      }

      if (url.pathname === "/acquire-promotion-lease") {
        const body = parseUpdateRequest(parseJsonText(rawBody));
        const session = await this.loadSession(body.sessionId);

        if (session.uploadId !== body.uploadId) {
          throw new HttpError(409, "upload_session_mismatch", "Upload session uploadId mismatch.", {
            sessionId: body.sessionId,
          });
        }

        if (session.status !== "active" && session.status !== "staged") {
          throw new HttpError(409, "upload_session_not_active", "Upload session is not active.", {
            sessionId: body.sessionId,
            status: session.status,
          });
        }

        this.assertNoLivePromotionLease(session, body.sessionId);

        // Reading and writing the lease here are both storage operations with
        // no intervening await, so the Durable Object's input gate serializes
        // this check-and-set against any other concurrent request for the
        // same session: a second caller cannot observe the pre-lease state.
        const promotionLeaseExpiresAt = new Date(Date.now() + PROMOTION_LEASE_MS).toISOString();
        const updated: SessionStorageRecord = {
          ...session,
          status: "staged",
          expiresAt: deferExpiryForLease(session, promotionLeaseExpiresAt),
          promotionLeaseExpiresAt,
          promotionLeaseToken: crypto.randomUUID(),
        };
        await this.state.storage.put(storageKey(body.sessionId), updated);
        await this.scheduleNextAlarm();
        return this.createSessionResponse(updated);
      }

      if (url.pathname === "/renew-promotion-lease") {
        const body = parseUpdateRequest(parseJsonText(rawBody));
        const session = await this.loadSession(body.sessionId);

        if (session.uploadId !== body.uploadId) {
          throw new HttpError(409, "upload_session_mismatch", "Upload session uploadId mismatch.", {
            sessionId: body.sessionId,
          });
        }

        // A released lease is not renewable. A holder whose lease lapsed
        // renews before its next copy write, so it stops here instead of
        // writing past a release; this keeps assertLeaseHolder's null-token
        // carve-out safe.
        if (session.status !== "staged" || session.promotionLeaseExpiresAt === null) {
          throw new HttpError(409, "upload_session_not_active", "Upload session holds no promotion lease.", {
            sessionId: body.sessionId,
            status: session.status,
          });
        }

        // The holder may renew a lease that already lapsed as long as no
        // retry took it over in the meantime: the token, not the clock, is
        // what decides ownership.
        this.assertLeaseHolder(session, body);

        const promotionLeaseExpiresAt = new Date(Date.now() + PROMOTION_LEASE_MS).toISOString();
        const updated: SessionStorageRecord = {
          ...session,
          expiresAt: deferExpiryForLease(session, promotionLeaseExpiresAt),
          promotionLeaseExpiresAt,
        };
        await this.state.storage.put(storageKey(body.sessionId), updated);
        await this.scheduleNextAlarm();
        return this.createSessionResponse(updated);
      }

      if (url.pathname === "/release-promotion-lease") {
        const body = parseUpdateRequest(parseJsonText(rawBody));
        const session = await this.loadSession(body.sessionId);

        if (session.uploadId !== body.uploadId) {
          throw new HttpError(409, "upload_session_mismatch", "Upload session uploadId mismatch.", {
            sessionId: body.sessionId,
          });
        }

        // Idempotent for the holder; a stale holder must not clear the lease
        // a retry now owns, so for it this is a no-op as well.
        if (
          session.promotionLeaseExpiresAt === null ||
          (session.promotionLeaseToken !== null && body.promotionLeaseToken !== session.promotionLeaseToken)
        ) {
          return this.createSessionResponse(session);
        }

        const updated: SessionStorageRecord = {
          ...session,
          promotionLeaseExpiresAt: null,
          promotionLeaseToken: null,
        };
        await this.state.storage.put(storageKey(body.sessionId), updated);
        return this.createSessionResponse(updated);
      }

      if (url.pathname === "/complete") {
        const body = parseUpdateRequest(parseJsonText(rawBody));
        const session = await this.loadSession(body.sessionId);

        if (session.uploadId !== body.uploadId) {
          throw new HttpError(409, "upload_session_mismatch", "Upload session uploadId mismatch.", {
            sessionId: body.sessionId,
          });
        }

        if (session.status !== "active" && session.status !== "staged") {
          throw new HttpError(409, "upload_session_not_active", "Upload session is not active.", {
            sessionId: body.sessionId,
            status: session.status,
          });
        }

        this.assertLeaseHolder(session, body);

        const updated: SessionStorageRecord = {
          ...session,
          status: "completed",
          completedAt: new Date().toISOString(),
          promotionLeaseExpiresAt: null,
          promotionLeaseToken: null,
        };
        await this.state.storage.put(storageKey(body.sessionId), updated);
        // Only now, with completion durable, are the staged bytes redundant:
        // a retry after a crash anywhere before this write still finds them
        // (or the promoted target) and can finish instead of failing with
        // upload_staged_object_missing.
        await this.reclaimStagedObject(updated);
        return this.createSessionResponse(updated);
      }

      if (url.pathname === "/abort") {
        const body = parseUpdateRequest(parseJsonText(rawBody));
        const session = await this.loadSession(body.sessionId);

        if (session.uploadId !== body.uploadId) {
          throw new HttpError(409, "upload_session_mismatch", "Upload session uploadId mismatch.", {
            sessionId: body.sessionId,
          });
        }

        if (session.status === "completed") {
          throw new HttpError(409, "upload_session_already_completed", "Upload session is already completed.", {
            sessionId: body.sessionId,
          });
        }

        if (session.status === "aborted") {
          return this.createSessionResponse(session);
        }

        if (session.status !== "active" && session.status !== "staged") {
          throw new HttpError(409, "upload_session_not_active", "Upload session is not active.", {
            sessionId: body.sessionId,
            status: session.status,
          });
        }

        // A live promotion lease means a complete call is between the
        // existence check and finishing promotion for this exact session:
        // refusing here, before touching storage, is what stops abort from
        // deleting that attempt's staged object out from under it.
        this.assertNoLivePromotionLease(session, body.sessionId);

        const updated: SessionStorageRecord = {
          ...session,
          status: "aborted",
          abortedAt: new Date().toISOString(),
          promotionLeaseExpiresAt: null,
          promotionLeaseToken: null,
        };
        await this.state.storage.put(storageKey(body.sessionId), updated);
        return this.createSessionResponse(updated);
      }

      if (url.pathname === "/gc-expired") {
        await this.pruneExpiredSessions(Date.now());
        await this.scheduleNextAlarm();
        return json({ ok: true });
      }

      return apiError(404, "not_found", "Upload session route not found.");
    } catch (error) {
      if (error instanceof HttpError) {
        return apiError(error.status, error.code, error.message, error.details);
      }
      console.error("Unhandled upload session store error:", error);
      return apiError(500, "internal_error", "Unexpected upload session store error.");
    }
  }
}

export type UploadSignedPartRecord = SignedPartRecord;
export type UploadSessionRecord = SessionStorageRecord;
export type UploadSessionStatus = SessionStatus;
