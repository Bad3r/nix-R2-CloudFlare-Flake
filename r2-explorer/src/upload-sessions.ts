import { apiError, HttpError, json } from "./http";
import type { Env } from "./types";

type SessionStatus = "init" | "active" | "completed" | "aborted" | "expired";

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
  objectKey: string;
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

function storageKey(sessionId: string): string {
  return `${SESSION_PREFIX}${sessionId}`;
}

function normalizeOwnerKey(ownerId: string): string {
  const trimmed = ownerId.trim();
  if (trimmed.length === 0) {
    throw new HttpError(400, "owner_required", "Upload session owner is required.");
  }
  // OAuth subjects can be case-sensitive opaque identifiers; preserve exact
  // bytes to avoid cross-principal collisions.
  return trimmed;
}

function parseRequestBody<T>(raw: string): T {
  if (raw.trim().length === 0) {
    throw new HttpError(400, "bad_request", "Request body is required.");
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new HttpError(400, "bad_request", "Request body must be valid JSON.", {
      cause: String(error),
    });
  }
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
  if (status === "init" || status === "active" || status === "completed" || status === "aborted" || status === "expired") {
    return status;
  }
  throw new HttpError(
    400,
    "validation_error",
    "session.status must be init, active, completed, aborted, or expired.",
  );
}

function parseSessionRecord(input: unknown): SessionStorageRecord {
  const record = asRecord(input);

  return {
    sessionId: asString(record.sessionId, "session.sessionId"),
    ownerId: asString(record.ownerId, "session.ownerId"),
    bucket: asString(record.bucket, "session.bucket"),
    uploadId: asString(record.uploadId, "session.uploadId"),
    objectKey: asString(record.objectKey, "session.objectKey"),
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

function isExpired(session: SessionStorageRecord, nowMs: number): boolean {
  return Date.parse(session.expiresAt) <= nowMs;
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
    private readonly _env: Env,
  ) {}

  private async pruneExpiredSessions(nowMs: number): Promise<void> {
    const listing = await this.state.storage.list<SessionStorageRecord>({ prefix: SESSION_PREFIX });
    const updates = new Map<string, SessionStorageRecord>();
    const deletes: string[] = [];

    for (const [key, value] of listing.entries()) {
      if (!isExpired(value, nowMs)) {
        continue;
      }

      if (value.status !== "expired") {
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

  private async activeSessionCount(nowMs: number): Promise<number> {
    const listing = await this.state.storage.list<SessionStorageRecord>({ prefix: SESSION_PREFIX });
    let count = 0;
    for (const value of listing.values()) {
      if (value.status === "active" && !isExpired(value, nowMs)) {
        count += 1;
      }
    }
    return count;
  }

  private async activeSessionForObjectKey(nowMs: number, objectKey: string): Promise<SessionStorageRecord | null> {
    const listing = await this.state.storage.list<SessionStorageRecord>({ prefix: SESSION_PREFIX });
    for (const value of listing.values()) {
      if (value.status === "active" && !isExpired(value, nowMs) && value.objectKey === objectKey) {
        return value;
      }
    }
    return null;
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
        const body = parseCreateRequest(parseRequestBody(rawBody));
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
        return this.createSessionResponse(activeSession);
      }

      if (url.pathname === "/get") {
        const body = parseSessionRequest(parseRequestBody(rawBody));
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
        const body = parseRecordSignedPartRequest(parseRequestBody(rawBody));
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

      if (url.pathname === "/complete") {
        const body = parseUpdateRequest(parseRequestBody(rawBody));
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

        const updated: SessionStorageRecord = {
          ...session,
          status: "completed",
          completedAt: new Date().toISOString(),
        };
        await this.state.storage.put(storageKey(body.sessionId), updated);
        return this.createSessionResponse(updated);
      }

      if (url.pathname === "/abort") {
        const body = parseUpdateRequest(parseRequestBody(rawBody));
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

        if (session.status !== "active") {
          throw new HttpError(409, "upload_session_not_active", "Upload session is not active.", {
            sessionId: body.sessionId,
            status: session.status,
          });
        }

        const updated: SessionStorageRecord = {
          ...session,
          status: "aborted",
          abortedAt: new Date().toISOString(),
        };
        await this.state.storage.put(storageKey(body.sessionId), updated);
        return this.createSessionResponse(updated);
      }

      if (url.pathname === "/gc-expired") {
        await this.pruneExpiredSessions(Date.now());
        return json({ ok: true });
      }

      return apiError(404, "not_found", "Upload session route not found.");
    } catch (error) {
      if (error instanceof HttpError) {
        return apiError(error.status, error.code, error.message, error.details);
      }
      return apiError(500, "internal_error", "Unexpected upload session store error.", {
        message: String(error),
      });
    }
  }
}

export type UploadSignedPartRecord = SignedPartRecord;
export type UploadSessionRecord = SessionStorageRecord;
export type UploadSessionStatus = SessionStatus;
