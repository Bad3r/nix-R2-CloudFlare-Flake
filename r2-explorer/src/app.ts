import { Hono, type MiddlewareHandler } from "hono";
import type { ZodTypeAny } from "zod";
import {
  extractAccessIdentity,
  getAdminAuthWindowSeconds,
  requireApiIdentity,
  verifyAdminSignature,
} from "./auth";
import { listBucketBindings, resolveBucket } from "./buckets";
import { apiError, contentDisposition, HttpError, json, notFound } from "./http";
import { getShareRecord, listSharesForObject, putShareRecord } from "./kv";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  getObject,
  headObject,
  listObjects,
  moveObject,
  softDeleteObject,
} from "./r2";
import {
  listQuerySchema,
  listResponseSchema,
  metaQuerySchema,
  metaResponseSchema,
  objectDeleteBodySchema,
  objectDeleteResponseSchema,
  objectMoveBodySchema,
  objectMoveResponseSchema,
  requestActorSchema,
  serverInfoResponseSchema,
  shareCreateBodySchema,
  shareCreateResponseSchema,
  shareListQuerySchema,
  shareListResponseSchema,
  shareRevokeBodySchema,
  shareRevokeResponseSchema,
  simpleOkResponseSchema,
  uploadAbortBodySchema,
  uploadCompleteBodySchema,
  uploadCompleteResponseSchema,
  uploadInitBodySchema,
  uploadInitResponseSchema,
  uploadSignPartBodySchema,
  uploadSignPartResponseSchema,
} from "./schemas";
import { signMultipartUploadPart } from "./upload-signing";
import {
  createUploadSession,
  markUploadSessionAborted,
  markUploadSessionCompleted,
  recordUploadSessionSignedPart,
  requireUploadSession,
  type UploadSessionRecord,
} from "./upload-sessions";
import type { AccessIdentity, Env, RequestActor, ShareRecord } from "./types";
import { renderAppHtml } from "./ui";
import { WORKER_VERSION } from "./version";

type AppVariables = {
  accessIdentity: AccessIdentity | null;
  rawBody: string;
  actor: string;
  authMode: "access" | "hmac";
};

type AppContext = {
  Bindings: Env;
  Variables: AppVariables;
};

type UploadPolicy = {
  bucketName: string;
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

const BASE62_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const JSON_BODY_PATHS = new Set([
  "/api/upload/init",
  "/api/upload/sign-part",
  "/api/upload/complete",
  "/api/upload/abort",
  "/api/object/delete",
  "/api/object/move",
  "/api/share/create",
  "/api/share/revoke",
]);
const UPLOAD_MUTATION_PATHS = new Set([
  "/api/upload/init",
  "/api/upload/sign-part",
  "/api/upload/complete",
  "/api/upload/abort",
]);
const R2_MAX_UPLOAD_PARTS = 10_000;
const R2_MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;
const R2_MAX_PART_SIZE_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_UPLOAD_PART_SIZE_BYTES = 8 * 1024 * 1024;
const DEFAULT_UPLOAD_SESSION_TTL_SEC = 3600;
const DEFAULT_UPLOAD_SIGN_TTL_SEC = 60;

function envInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function envNonNegativeInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function envBool(value: string | undefined, fallback = false): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseList(value: string | undefined): string[] {
  if (!value || value.trim().length === 0) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeObjectKey(key: string): string {
  return key.replace(/^\/+/, "");
}

function normalizeMimeType(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

const ZIP_CONTAINER_MIME_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/java-archive",
  "application/vnd.android.package-archive",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
]);

function isZipContainerMime(contentType: string): boolean {
  return ZIP_CONTAINER_MIME_TYPES.has(contentType) || contentType.endsWith("+zip");
}

function magicMimeMatchesDeclared(declaredContentType: string, detectedMime: string): boolean {
  if (declaredContentType === detectedMime) {
    return true;
  }
  if (detectedMime === "application/zip" && isZipContainerMime(declaredContentType)) {
    return true;
  }
  return false;
}

function normalizeUploadPrefix(prefix: string | undefined): string {
  if (!prefix || prefix.trim().length === 0) {
    return "";
  }

  const normalized = prefix.trim().replace(/^\/+/, "");
  if (normalized.includes("..")) {
    throw new HttpError(400, "invalid_upload_prefix", "Upload prefix cannot contain '..'.");
  }
  if (normalized.includes("\\")) {
    throw new HttpError(400, "invalid_upload_prefix", "Upload prefix cannot contain backslashes.");
  }
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function extractExtension(filename: string): string {
  const index = filename.lastIndexOf(".");
  if (index <= 0 || index >= filename.length - 1) {
    return "";
  }
  const extension = filename.slice(index).toLowerCase();
  if (!/^\.[a-z0-9]+$/.test(extension)) {
    return "";
  }
  return extension;
}

function normalizeAllowedExtension(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (!lower) {
    return "";
  }
  const withDot = lower.startsWith(".") ? lower : `.${lower}`;
  if (!/^\.[a-z0-9]+$/.test(withDot)) {
    throw new HttpError(500, "upload_config_invalid", `Invalid extension in R2E_UPLOAD_ALLOWED_EXT: ${raw}`);
  }
  return withDot;
}

function requireUploadBucketName(env: Env): string {
  const bucketName = env.R2E_UPLOAD_S3_BUCKET?.trim();
  if (!bucketName) {
    throw new HttpError(
      500,
      "upload_config_invalid",
      "Missing required Worker variable R2E_UPLOAD_S3_BUCKET for upload signing.",
    );
  }
  return bucketName;
}

function parseUploadPolicy(env: Env): UploadPolicy {
  const configuredMaxParts = envNonNegativeInt(env.R2E_UPLOAD_MAX_PARTS, 0);
  const maxParts = configuredMaxParts === 0 ? R2_MAX_UPLOAD_PARTS : Math.min(configuredMaxParts, R2_MAX_UPLOAD_PARTS);

  const configuredPartSize = envInt(env.R2E_UPLOAD_PART_SIZE_BYTES, DEFAULT_UPLOAD_PART_SIZE_BYTES);
  if (configuredPartSize < R2_MIN_PART_SIZE_BYTES || configuredPartSize > R2_MAX_PART_SIZE_BYTES) {
    throw new HttpError(
      500,
      "upload_config_invalid",
      `R2E_UPLOAD_PART_SIZE_BYTES must be between ${R2_MIN_PART_SIZE_BYTES} and ${R2_MAX_PART_SIZE_BYTES}.`,
    );
  }

  const allowedMime = Array.from(new Set(parseList(env.R2E_UPLOAD_ALLOWED_MIME).map(normalizeMimeType)));
  const blockedMime = Array.from(new Set(parseList(env.R2E_UPLOAD_BLOCKED_MIME).map(normalizeMimeType)));
  const allowedExtensions = Array.from(
    new Set(
      parseList(env.R2E_UPLOAD_ALLOWED_EXT)
        .map(normalizeAllowedExtension)
        .filter((extension) => extension.length > 0),
    ),
  );
  const blockedExtensions = Array.from(
    new Set(
      parseList(env.R2E_UPLOAD_BLOCKED_EXT)
        .map(normalizeAllowedExtension)
        .filter((extension) => extension.length > 0),
    ),
  );
  const prefixAllowlist = Array.from(
    new Set(
      parseList(env.R2E_UPLOAD_PREFIX_ALLOWLIST)
        .map((prefix) => normalizeUploadPrefix(prefix))
        .filter((prefix) => prefix.length > 0),
    ),
  );

  return {
    bucketName: requireUploadBucketName(env),
    maxFileBytes: envNonNegativeInt(env.R2E_UPLOAD_MAX_FILE_BYTES, 0),
    maxParts,
    maxConcurrentPerUser: envNonNegativeInt(env.R2E_UPLOAD_MAX_CONCURRENT_PER_USER, 0),
    sessionTtlSec: envInt(env.R2E_UPLOAD_SESSION_TTL_SEC, DEFAULT_UPLOAD_SESSION_TTL_SEC),
    signPartTtlSec: envInt(env.R2E_UPLOAD_SIGN_TTL_SEC, DEFAULT_UPLOAD_SIGN_TTL_SEC),
    partSizeBytes: configuredPartSize,
    allowedMime,
    blockedMime,
    allowedExtensions,
    blockedExtensions,
    prefixAllowlist,
  };
}

function parseAllowedOrigins(env: Env, requestOrigin: string): Set<string> {
  const configured = parseList(env.R2E_UPLOAD_ALLOWED_ORIGINS);
  if (configured.length === 0) {
    return new Set([requestOrigin]);
  }

  const origins = new Set<string>();
  for (const entry of configured) {
    try {
      origins.add(new URL(entry).origin);
    } catch {
      throw new HttpError(500, "upload_config_invalid", `Invalid origin in R2E_UPLOAD_ALLOWED_ORIGINS: ${entry}`);
    }
  }
  return origins;
}

function parseDurationSeconds(raw: unknown, fallbackSeconds: number, maxSeconds: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const rounded = Math.floor(raw);
    if (rounded <= 0) {
      throw new HttpError(400, "invalid_ttl", "ttl must be a positive number of seconds.");
    }
    return Math.min(rounded, maxSeconds);
  }

  if (typeof raw === "string" && raw.trim().length > 0) {
    const value = raw.trim();
    const match = value.match(/^([0-9]+)([smhd]?)$/);
    if (!match) {
      throw new HttpError(400, "invalid_ttl", "ttl must match <number>[s|m|h|d].");
    }

    const amount = Number.parseInt(match[1], 10);
    const unit = match[2] || "s";
    const multiplier =
      unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : unit === "d" ? 86400 : 1;
    const seconds = amount * multiplier;
    if (seconds <= 0) {
      throw new HttpError(400, "invalid_ttl", "ttl must be greater than zero.");
    }
    return Math.min(seconds, maxSeconds);
  }

  return fallbackSeconds;
}

function randomTokenId(length = 22): string {
  let output = "";
  while (output.length < length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= 248) {
        continue;
      }
      output += BASE62_ALPHABET[byte % 62];
      if (output.length >= length) {
        return output;
      }
    }
  }
  return output;
}

function isInlinePreview(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }
  if (contentType.startsWith("text/")) {
    return true;
  }
  if (contentType.startsWith("image/")) {
    return true;
  }
  return contentType === "application/pdf" || contentType === "application/json";
}

function guessContentType(key: string): string {
  const lower = key.toLowerCase();
  if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

function baseUrl(request: Request, env: Env): string {
  if (env.R2E_PUBLIC_BASE_URL && env.R2E_PUBLIC_BASE_URL.trim().length > 0) {
    return env.R2E_PUBLIC_BASE_URL.replace(/\/+$/, "");
  }
  return new URL(request.url).origin;
}

function shareStillValid(record: ShareRecord): boolean {
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

async function incrementShareDownload(env: Env, tokenId: string): Promise<ShareRecord> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const current = await getShareRecord(env.R2E_SHARES_KV, tokenId);
    if (!current) {
      throw new HttpError(404, "share_not_found", "Share token not found.");
    }
    if (!shareStillValid(current)) {
      throw new HttpError(410, "share_expired", "Share token is expired, revoked, or exhausted.");
    }

    const expiresAtEpoch = Math.floor(Date.parse(current.expiresAt) / 1000);
    const nowEpoch = Math.floor(Date.now() / 1000);
    const ttl = Math.max(60, expiresAtEpoch - nowEpoch);
    const updated: ShareRecord = { ...current, downloadCount: current.downloadCount + 1 };
    await putShareRecord(env.R2E_SHARES_KV, updated, ttl);
    return updated;
  }

  throw new HttpError(409, "share_conflict", "Unable to update share download count.");
}

function requestActor(c: { get: (key: "authMode" | "actor") => "access" | "hmac" | string }): RequestActor {
  const actor = c.get("actor");
  const mode = c.get("authMode");
  const payload = {
    mode: mode === "hmac" ? "hmac" : "access",
    actor: actor || "unknown",
  };
  return requestActorSchema.parse(payload);
}

function queryPayload(request: Request): Record<string, string> {
  const payload: Record<string, string> = {};
  const search = new URL(request.url).searchParams;
  search.forEach((value, key) => {
    payload[key] = value;
  });
  return payload;
}

function validateSchema<T extends ZodTypeAny>(schema: T, payload: unknown, label: string): T["_output"] {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new HttpError(400, "validation_error", `Invalid ${label}.`, {
      issues: result.error.issues,
    });
  }
  return result.data;
}

function readJsonBody<T extends ZodTypeAny>(
  c: { get: (key: "rawBody") => string },
  schema: T,
): T["_output"] {
  const rawBody = c.get("rawBody");
  if (!rawBody || rawBody.trim().length === 0) {
    throw new HttpError(400, "bad_request", "Request body is required.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (error) {
    throw new HttpError(400, "bad_request", "Request body must be valid JSON.", {
      parseError: String(error),
    });
  }
  return validateSchema(schema, parsed, "request body");
}

function jsonValidated<T extends ZodTypeAny>(schema: T, payload: unknown, init?: ResponseInit): Response {
  return json(validateSchema(schema, payload, "response payload"), init);
}

function requireUploadActor(c: { get: (key: "actor") => string }): string {
  const actor = c.get("actor");
  if (!actor || actor.trim().length === 0) {
    throw new HttpError(401, "access_required", "Authenticated upload actor is required.");
  }
  return actor;
}

function requireUploadFilename(filename: string): string {
  const trimmed = filename.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") {
    throw new HttpError(400, "invalid_upload_filename", "Upload filename must be non-empty.");
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new HttpError(400, "invalid_upload_filename", "Upload filename cannot contain path separators.");
  }
  if (trimmed.length > 255) {
    throw new HttpError(400, "invalid_upload_filename", "Upload filename exceeds 255 characters.");
  }
  return trimmed;
}

function buildRandomObjectKey(prefix: string, filename: string): string {
  const extension = extractExtension(filename);
  return `${prefix}${randomTokenId(34)}${extension}`;
}

function prefixAllowed(prefix: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) {
    return true;
  }
  return allowlist.some((allowedPrefix) => prefix.startsWith(allowedPrefix));
}

function expectedPartCount(declaredSize: number, partSizeBytes: number): number {
  return Math.max(1, Math.ceil(declaredSize / partSizeBytes));
}

function validateCompleteParts(
  parts: Array<{ partNumber: number; etag: string }>,
  maxParts: number,
): void {
  let previousPartNumber = 0;
  const seen = new Set<number>();
  for (const part of parts) {
    if (part.partNumber > maxParts) {
      throw new HttpError(400, "invalid_part_number", "Part number exceeds allowed max parts.", {
        partNumber: part.partNumber,
        maxParts,
      });
    }
    if (seen.has(part.partNumber)) {
      throw new HttpError(400, "duplicate_part_number", "Duplicate part number in complete request.", {
        partNumber: part.partNumber,
      });
    }
    if (part.partNumber <= previousPartNumber) {
      throw new HttpError(400, "invalid_part_order", "Parts must be strictly ordered by partNumber.");
    }
    seen.add(part.partNumber);
    previousPartNumber = part.partNumber;
  }
}

function parseOrigin(origin: string | null): string {
  if (!origin || origin.trim().length === 0) {
    throw new HttpError(403, "origin_required", "Origin header is required for upload mutation routes.");
  }
  try {
    return new URL(origin).origin;
  } catch {
    throw new HttpError(403, "origin_invalid", "Origin header is not a valid URL origin.");
  }
}

function assertUploadMutationGuards(request: Request, env: Env): void {
  const requestOrigin = new URL(request.url).origin;
  const origin = parseOrigin(request.headers.get("origin"));
  const allowedOrigins = parseAllowedOrigins(env, requestOrigin);
  if (!allowedOrigins.has(origin)) {
    throw new HttpError(403, "origin_not_allowed", "Origin is not allowed for upload mutation route.", {
      origin,
      allowedOrigins: [...allowedOrigins],
    });
  }

  const csrf = request.headers.get("x-r2e-csrf");
  if (!csrf || csrf.trim() !== "1") {
    throw new HttpError(403, "csrf_required", "Missing required x-r2e-csrf header for upload mutation route.");
  }
}

function bytesEqual(input: Uint8Array, expected: number[], offset = 0): boolean {
  if (offset + expected.length > input.length) {
    return false;
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (input[offset + index] !== expected[index]) {
      return false;
    }
  }
  return true;
}

function detectMagicMime(bytes: Uint8Array): string | null {
  if (bytesEqual(bytes, [0x25, 0x50, 0x44, 0x46])) {
    return "application/pdf";
  }
  if (bytesEqual(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (bytesEqual(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (bytesEqual(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) || bytesEqual(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])) {
    return "image/gif";
  }
  if (bytesEqual(bytes, [0x52, 0x49, 0x46, 0x46]) && bytesEqual(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  if (bytesEqual(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return "application/zip";
  }
  return null;
}

async function uploadedMagicMime(bucket: R2Bucket, key: string): Promise<string | null> {
  const object = await bucket.get(key, {
    range: {
      offset: 0,
      length: 16,
    },
  });
  if (!object || object.body === null) {
    throw new HttpError(404, "object_not_found", `Uploaded object not found for magic-byte validation: ${key}`);
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  return detectMagicMime(bytes);
}

async function responseFromObject(
  object: R2ObjectBody,
  key: string,
  disposition: "attachment" | "inline",
  forceContentType?: string,
): Promise<Response> {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", forceContentType ?? guessContentType(key));
  } else if (forceContentType) {
    headers.set("content-type", forceContentType);
  }
  headers.set("content-disposition", contentDisposition(disposition, key));
  headers.set("cache-control", "private, max-age=0, no-store");
  return new Response(object.body, { status: 200, headers });
}

const accessMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const identity = await requireApiIdentity(c.req.raw, c.env);
  c.set("accessIdentity", identity);
  c.set("actor", identity.email ?? identity.userId ?? "");
  c.set("authMode", "access");
  await next();
};

const accessOrHmacMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  if (c.get("accessIdentity")) {
    const identity = await requireApiIdentity(c.req.raw, c.env);
    c.set("accessIdentity", identity);
    c.set("actor", identity.email ?? identity.userId ?? "");
    c.set("authMode", "access");
    await next();
    return;
  }

  const rawBody = c.get("rawBody");
  const kid = await verifyAdminSignature(c.req.raw, c.env, rawBody ?? "");
  c.set("actor", `hmac:${kid}`);
  c.set("authMode", "hmac");
  await next();
};

export function createApp(): Hono<AppContext> {
  const app = new Hono<AppContext>();

  app.use("/api/*", async (c, next) => {
    c.set("accessIdentity", extractAccessIdentity(c.req.raw));
    c.set("rawBody", "");
    c.set("actor", "");
    c.set("authMode", "access");
    await next();
  });

  app.use("/api/*", async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (envBool(c.env.R2E_READONLY, false) && method !== "GET" && method !== "HEAD") {
      throw new HttpError(403, "readonly_mode", "This explorer is in readonly mode.");
    }
    await next();
  });

  app.use("/api/*", async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === "POST" && UPLOAD_MUTATION_PATHS.has(c.req.path)) {
      assertUploadMutationGuards(c.req.raw, c.env);
    }
    await next();
  });

  app.use("/api/*", async (c, next) => {
    if (c.req.method.toUpperCase() === "POST" && JSON_BODY_PATHS.has(c.req.path)) {
      c.set("rawBody", await c.req.text());
    }
    await next();
  });

  for (const path of [
    "/api/list",
    "/api/meta",
    "/api/download",
    "/api/preview",
    "/api/upload/init",
    "/api/upload/sign-part",
    "/api/upload/complete",
    "/api/upload/abort",
    "/api/object/delete",
    "/api/object/move",
    "/api/server/info",
  ]) {
    app.use(path, accessMiddleware);
  }

  for (const path of ["/api/share/create", "/api/share/revoke", "/api/share/list"]) {
    app.use(path, accessOrHmacMiddleware);
  }

  app.get("/", async () => {
    return new Response(renderAppHtml(), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  });

  app.get("/api/list", async (c) => {
    const query = validateSchema(listQuerySchema, queryPayload(c.req.raw), "query");
    const configuredLimit = envInt(c.env.R2E_UI_MAX_LIST_LIMIT, 1000);
    const limit = Math.min(query.limit, configuredLimit);
    const result = await listObjects(c.env.FILES_BUCKET, query.prefix, query.cursor, limit);
    const payload = {
      prefix: query.prefix,
      cursor: result.truncated ? result.cursor : undefined,
      listComplete: !result.truncated,
      delimitedPrefixes: result.delimitedPrefixes ?? [],
      objects: result.objects.map((object) => ({
        key: object.key,
        size: object.size,
        etag: object.etag,
        uploaded: object.uploaded ? object.uploaded.toISOString() : null,
        storageClass: object.storageClass ?? null,
      })),
      identity: requestActor(c),
    };
    return jsonValidated(listResponseSchema, payload);
  });

  app.get("/api/meta", async (c) => {
    const query = validateSchema(metaQuerySchema, queryPayload(c.req.raw), "query");
    const key = normalizeObjectKey(query.key);
    const object = await headObject(c.env.FILES_BUCKET, key);
    if (!object) {
      throw new HttpError(404, "object_not_found", `Object not found: ${key}`);
    }
    return jsonValidated(metaResponseSchema, {
      key: object.key,
      etag: object.etag,
      size: object.size,
      uploaded: object.uploaded ? object.uploaded.toISOString() : null,
      storageClass: object.storageClass ?? null,
      httpEtag: object.httpEtag ?? null,
    });
  });

  app.get("/api/download", async (c) => {
    const query = validateSchema(metaQuerySchema, queryPayload(c.req.raw), "query");
    const key = normalizeObjectKey(query.key);
    const object = await getObject(c.env.FILES_BUCKET, key);
    return responseFromObject(object, key, "attachment");
  });

  app.get("/api/preview", async (c) => {
    const query = validateSchema(metaQuerySchema, queryPayload(c.req.raw), "query");
    const key = normalizeObjectKey(query.key);
    const object = await getObject(c.env.FILES_BUCKET, key);
    const tempHeaders = new Headers();
    object.writeHttpMetadata(tempHeaders);
    const sourceType = tempHeaders.get("content-type") ?? guessContentType(key);
    const inline = isInlinePreview(sourceType);
    return responseFromObject(object, key, inline ? "inline" : "attachment", sourceType);
  });

  app.post("/api/upload/init", async (c) => {
    const body = readJsonBody(c, uploadInitBodySchema);
    const policy = parseUploadPolicy(c.env);
    const actor = requireUploadActor(c);
    const filename = requireUploadFilename(body.filename);
    const prefix = normalizeUploadPrefix(body.prefix);
    if (!prefixAllowed(prefix, policy.prefixAllowlist)) {
      throw new HttpError(403, "upload_prefix_forbidden", "Upload prefix is not allowed for this deployment.", {
        prefix,
        allowedPrefixes: policy.prefixAllowlist,
      });
    }

    const extension = extractExtension(filename);
    if (extension && policy.blockedExtensions.includes(extension)) {
      throw new HttpError(400, "upload_extension_blocked", "File extension is blocked by server policy.", {
        extension,
        blockedExtensions: policy.blockedExtensions,
      });
    }
    if (policy.allowedExtensions.length > 0 && !policy.allowedExtensions.includes(extension)) {
      throw new HttpError(400, "upload_extension_not_allowed", "File extension is not allowed.", {
        extension,
        allowedExtensions: policy.allowedExtensions,
      });
    }

    const contentType = body.contentType?.trim().length
      ? body.contentType.trim()
      : guessContentType(filename).replace(/;.*$/, "");
    const normalizedContentType = normalizeMimeType(contentType);
    if (policy.blockedMime.includes(normalizedContentType)) {
      throw new HttpError(400, "upload_content_type_blocked", "Content-Type is blocked by server policy.", {
        contentType: normalizedContentType,
        blockedMime: policy.blockedMime,
      });
    }
    if (policy.allowedMime.length > 0 && !policy.allowedMime.includes(normalizedContentType)) {
      throw new HttpError(400, "upload_content_type_not_allowed", "Content-Type is not allowed.", {
        contentType: normalizedContentType,
        allowedMime: policy.allowedMime,
      });
    }

    const declaredSize = body.declaredSize;
    if (policy.maxFileBytes > 0 && declaredSize > policy.maxFileBytes) {
      throw new HttpError(413, "upload_size_limit", "Declared file size exceeds configured maximum.", {
        declaredSize,
        maxFileBytes: policy.maxFileBytes,
      });
    }
    const partsNeeded = expectedPartCount(declaredSize, policy.partSizeBytes);
    if (partsNeeded > policy.maxParts) {
      throw new HttpError(413, "upload_part_limit", "Declared file size exceeds maximum supported multipart parts.", {
        partsNeeded,
        maxParts: policy.maxParts,
      });
    }

    const key = normalizeObjectKey(buildRandomObjectKey(prefix, filename));
    const sessionId = randomTokenId(28);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + policy.sessionTtlSec * 1000).toISOString();

    const upload = await createMultipartUpload(c.env.FILES_BUCKET, key, {
      contentType,
      customMetadata: {
        originalFilename: filename,
        ...(body.sha256 ? { declaredSha256: body.sha256 } : {}),
      },
    });

    const sessionRecord: UploadSessionRecord = {
      sessionId,
      ownerId: actor,
      bucket: policy.bucketName,
      uploadId: upload.uploadId,
      objectKey: upload.key,
      filename,
      contentType,
      declaredSize,
      sha256: body.sha256 ?? null,
      prefix,
      maxParts: policy.maxParts,
      maxFileBytes: policy.maxFileBytes,
      partSizeBytes: policy.partSizeBytes,
      createdAt,
      expiresAt,
      status: "init",
      completedAt: null,
      abortedAt: null,
      signedParts: {},
    };

    try {
      await createUploadSession(c.env, actor, {
        session: sessionRecord,
        maxConcurrentUploads: policy.maxConcurrentPerUser,
      });
    } catch (error) {
      await abortMultipartUpload(c.env.FILES_BUCKET, upload.key, upload.uploadId).catch(() => undefined);
      throw error;
    }

    return jsonValidated(uploadInitResponseSchema, {
      sessionId,
      objectKey: upload.key,
      uploadId: upload.uploadId,
      expiresAt,
      partSizeBytes: policy.partSizeBytes,
      maxParts: policy.maxParts,
      signPartTtlSec: policy.signPartTtlSec,
      allowedMime: policy.allowedMime,
      allowedExt: policy.allowedExtensions,
    });
  });

  app.post("/api/upload/sign-part", async (c) => {
    const body = readJsonBody(c, uploadSignPartBodySchema);
    const actor = requireUploadActor(c);
    const session = await requireUploadSession(c.env, actor, {
      sessionId: body.sessionId,
      requireActive: true,
    });

    if (session.uploadId !== body.uploadId) {
      throw new HttpError(409, "upload_session_mismatch", "uploadId does not match upload session.");
    }

    if (body.partNumber > session.maxParts) {
      throw new HttpError(400, "invalid_part_number", "partNumber exceeds allowed max parts.", {
        partNumber: body.partNumber,
        maxParts: session.maxParts,
      });
    }

    if (body.contentLength > R2_MAX_PART_SIZE_BYTES) {
      throw new HttpError(400, "invalid_part_size", "Part size exceeds R2 maximum part size.", {
        contentLength: body.contentLength,
        maxPartSizeBytes: R2_MAX_PART_SIZE_BYTES,
      });
    }

    const expectedParts = expectedPartCount(session.declaredSize, session.partSizeBytes);
    if (body.partNumber > expectedParts) {
      throw new HttpError(400, "invalid_part_number", "partNumber exceeds expected part count for declaredSize.", {
        partNumber: body.partNumber,
        expectedParts,
      });
    }

    if (body.partNumber < expectedParts && body.contentLength !== session.partSizeBytes) {
      throw new HttpError(400, "invalid_part_size", "Non-final part size must equal configured partSizeBytes.", {
        partNumber: body.partNumber,
        expectedPartSizeBytes: session.partSizeBytes,
        contentLength: body.contentLength,
      });
    }

    if (body.partNumber === expectedParts) {
      const remaining = session.declaredSize - session.partSizeBytes * (expectedParts - 1);
      const expectedFinalSize = remaining > 0 ? remaining : session.partSizeBytes;
      if (body.contentLength !== expectedFinalSize) {
        throw new HttpError(400, "invalid_part_size", "Final part size does not match declaredSize.", {
          expectedFinalSize,
          contentLength: body.contentLength,
        });
      }
    }

    const policy = parseUploadPolicy(c.env);
    const signed = await signMultipartUploadPart(c.env, {
      bucketName: session.bucket,
      key: session.objectKey,
      uploadId: session.uploadId,
      partNumber: body.partNumber,
      expiresInSec: policy.signPartTtlSec,
      contentLength: body.contentLength,
      contentType: session.contentType,
      contentMd5: body.contentMd5,
    });
    await recordUploadSessionSignedPart(c.env, actor, {
      sessionId: session.sessionId,
      uploadId: session.uploadId,
      partNumber: body.partNumber,
      contentLength: body.contentLength,
      contentMd5: body.contentMd5,
    });

    return jsonValidated(uploadSignPartResponseSchema, {
      sessionId: session.sessionId,
      uploadId: session.uploadId,
      partNumber: body.partNumber,
      url: signed.url,
      method: signed.method,
      headers: signed.headers,
      expiresAt: signed.expiresAt,
    });
  });

  app.post("/api/upload/complete", async (c) => {
    const body = readJsonBody(c, uploadCompleteBodySchema);
    const actor = requireUploadActor(c);
    const session = await requireUploadSession(c.env, actor, {
      sessionId: body.sessionId,
      requireActive: true,
    });

    if (session.uploadId !== body.uploadId) {
      throw new HttpError(409, "upload_session_mismatch", "uploadId does not match upload session.");
    }

    validateCompleteParts(body.parts, session.maxParts);

    const expectedParts = expectedPartCount(session.declaredSize, session.partSizeBytes);
    if (body.parts.length !== expectedParts) {
      throw new HttpError(400, "invalid_part_count", "Part count does not match declaredSize.", {
        expectedParts,
        receivedParts: body.parts.length,
      });
    }

    const object = await completeMultipartUpload(
      c.env.FILES_BUCKET,
      session.objectKey,
      session.uploadId,
      body.parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
    );

    if (session.maxFileBytes > 0 && object.size > session.maxFileBytes) {
      await c.env.FILES_BUCKET.delete(session.objectKey);
      await markUploadSessionAborted(c.env, actor, {
        sessionId: session.sessionId,
        uploadId: session.uploadId,
      }).catch(() => undefined);
      throw new HttpError(413, "upload_size_limit", "Completed upload exceeds configured maximum file size.", {
        size: object.size,
        maxFileBytes: session.maxFileBytes,
      });
    }

    if (object.size !== session.declaredSize) {
      await c.env.FILES_BUCKET.delete(session.objectKey);
      await markUploadSessionAborted(c.env, actor, {
        sessionId: session.sessionId,
        uploadId: session.uploadId,
      }).catch(() => undefined);
      throw new HttpError(400, "upload_size_mismatch", "Completed upload size does not match declaredSize.", {
        size: object.size,
        declaredSize: session.declaredSize,
      });
    }

    if (typeof body.finalSize === "number" && object.size !== body.finalSize) {
      await c.env.FILES_BUCKET.delete(session.objectKey);
      await markUploadSessionAborted(c.env, actor, {
        sessionId: session.sessionId,
        uploadId: session.uploadId,
      }).catch(() => undefined);
      throw new HttpError(400, "upload_final_size_mismatch", "Completed upload size does not match finalSize.", {
        size: object.size,
        finalSize: body.finalSize,
      });
    }

    const policy = parseUploadPolicy(c.env);
    const detectedMime = await uploadedMagicMime(c.env.FILES_BUCKET, session.objectKey);
    const normalizedContentType = normalizeMimeType(session.contentType);
    if (detectedMime && !magicMimeMatchesDeclared(normalizedContentType, detectedMime)) {
      await c.env.FILES_BUCKET.delete(session.objectKey);
      await markUploadSessionAborted(c.env, actor, {
        sessionId: session.sessionId,
        uploadId: session.uploadId,
      }).catch(() => undefined);
      throw new HttpError(400, "upload_magic_mismatch", "Magic-byte type does not match declared Content-Type.", {
        declaredContentType: normalizedContentType,
        detectedMime,
      });
    }

    if (policy.blockedMime.includes(normalizedContentType)) {
      await c.env.FILES_BUCKET.delete(session.objectKey);
      await markUploadSessionAborted(c.env, actor, {
        sessionId: session.sessionId,
        uploadId: session.uploadId,
      }).catch(() => undefined);
      throw new HttpError(400, "upload_content_type_blocked", "Declared Content-Type is blocked by server policy.", {
        contentType: normalizedContentType,
        blockedMime: policy.blockedMime,
      });
    }

    if (detectedMime && policy.blockedMime.includes(detectedMime)) {
      await c.env.FILES_BUCKET.delete(session.objectKey);
      await markUploadSessionAborted(c.env, actor, {
        sessionId: session.sessionId,
        uploadId: session.uploadId,
      }).catch(() => undefined);
      throw new HttpError(400, "upload_magic_blocked", "Detected file type is blocked by server policy.", {
        detectedMime,
        blockedMime: policy.blockedMime,
      });
    }

    if (policy.allowedMime.length > 0 && !policy.allowedMime.includes(normalizedContentType)) {
      await c.env.FILES_BUCKET.delete(session.objectKey);
      await markUploadSessionAborted(c.env, actor, {
        sessionId: session.sessionId,
        uploadId: session.uploadId,
      }).catch(() => undefined);
      throw new HttpError(400, "upload_content_type_not_allowed", "Declared Content-Type is not allowed.", {
        contentType: normalizedContentType,
        allowedMime: policy.allowedMime,
      });
    }

    if (detectedMime && policy.allowedMime.length > 0 && !policy.allowedMime.includes(detectedMime)) {
      await c.env.FILES_BUCKET.delete(session.objectKey);
      await markUploadSessionAborted(c.env, actor, {
        sessionId: session.sessionId,
        uploadId: session.uploadId,
      }).catch(() => undefined);
      throw new HttpError(400, "upload_magic_not_allowed", "Detected file type is not allowed.", {
        detectedMime,
        allowedMime: policy.allowedMime,
      });
    }

    await markUploadSessionCompleted(c.env, actor, {
      sessionId: session.sessionId,
      uploadId: session.uploadId,
    });

    return jsonValidated(uploadCompleteResponseSchema, {
      key: object.key,
      etag: object.etag,
      uploaded: object.uploaded ? object.uploaded.toISOString() : null,
      size: object.size,
      contentType: session.contentType,
      originalFilename: session.filename,
    });
  });

  app.post("/api/upload/abort", async (c) => {
    const body = readJsonBody(c, uploadAbortBodySchema);
    const actor = requireUploadActor(c);
    const session = await requireUploadSession(c.env, actor, {
      sessionId: body.sessionId,
      requireActive: false,
    });

    if (session.uploadId !== body.uploadId) {
      throw new HttpError(409, "upload_session_mismatch", "uploadId does not match upload session.");
    }

    if (session.status === "completed") {
      throw new HttpError(409, "upload_session_already_completed", "Completed upload sessions cannot be aborted.");
    }

    if (session.status === "aborted") {
      return jsonValidated(simpleOkResponseSchema, { ok: true });
    }

    await abortMultipartUpload(c.env.FILES_BUCKET, session.objectKey, session.uploadId);
    await markUploadSessionAborted(c.env, actor, {
      sessionId: session.sessionId,
      uploadId: session.uploadId,
    });
    return jsonValidated(simpleOkResponseSchema, { ok: true });
  });

  app.post("/api/object/delete", async (c) => {
    const body = readJsonBody(c, objectDeleteBodySchema);
    const key = normalizeObjectKey(body.key);
    const result = await softDeleteObject(c.env.FILES_BUCKET, key);
    return jsonValidated(objectDeleteResponseSchema, {
      key,
      trashKey: result.trashKey,
    });
  });

  app.post("/api/object/move", async (c) => {
    const body = readJsonBody(c, objectMoveBodySchema);
    const fromKey = normalizeObjectKey(body.fromKey);
    const toKey = normalizeObjectKey(body.toKey);
    await moveObject(c.env.FILES_BUCKET, fromKey, toKey);
    return jsonValidated(objectMoveResponseSchema, {
      fromKey,
      toKey,
    });
  });

  app.post("/api/share/create", async (c) => {
    const body = readJsonBody(c, shareCreateBodySchema);
    const key = normalizeObjectKey(body.key);
    const bucketAlias = body.bucket ?? "files";
    const { bucket: r2Bucket } = resolveBucket(c.env, bucketAlias);
    const exists = await headObject(r2Bucket, key);
    if (!exists) {
      throw new HttpError(404, "object_not_found", `Object not found: ${key}`);
    }

    const maxTtl = envInt(c.env.R2E_MAX_SHARE_TTL_SEC, 2592000);
    const defaultTtl = envInt(c.env.R2E_DEFAULT_SHARE_TTL_SEC, 86400);
    const ttl = parseDurationSeconds(body.ttl, defaultTtl, maxTtl);
    const maxDownloads = body.maxDownloads ?? 0;
    const contentDisposition = body.contentDisposition ?? "attachment";
    const tokenId = randomTokenId();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const record: ShareRecord = {
      tokenId,
      bucket: bucketAlias,
      key,
      createdAt,
      expiresAt,
      maxDownloads,
      downloadCount: 0,
      revoked: false,
      createdBy: c.get("actor"),
      contentDisposition,
    };
    await putShareRecord(c.env.R2E_SHARES_KV, record, ttl);
    return jsonValidated(shareCreateResponseSchema, {
      tokenId,
      url: `${baseUrl(c.req.raw, c.env)}/share/${tokenId}`,
      expiresAt,
      maxDownloads,
      bucket: bucketAlias,
      key,
    });
  });

  app.post("/api/share/revoke", async (c) => {
    const body = readJsonBody(c, shareRevokeBodySchema);
    const record = await getShareRecord(c.env.R2E_SHARES_KV, body.tokenId);
    if (!record) {
      throw new HttpError(404, "share_not_found", "Share token not found.");
    }

    const nowEpoch = Math.floor(Date.now() / 1000);
    const expiresAtEpoch = Math.floor(Date.parse(record.expiresAt) / 1000);
    const ttl = Math.max(3600, expiresAtEpoch - nowEpoch);
    await putShareRecord(c.env.R2E_SHARES_KV, { ...record, revoked: true }, ttl);
    return jsonValidated(shareRevokeResponseSchema, {
      tokenId: body.tokenId,
      revoked: true,
    });
  });

  app.get("/api/share/list", async (c) => {
    const query = validateSchema(shareListQuerySchema, queryPayload(c.req.raw), "query");
    const { alias: bucketAlias } = resolveBucket(c.env, query.bucket);
    const listing = await listSharesForObject(
      c.env.R2E_SHARES_KV,
      bucketAlias,
      normalizeObjectKey(query.key),
      query.limit,
      query.cursor,
    );
    return jsonValidated(shareListResponseSchema, listing);
  });

  app.get("/api/server/info", async (c) => {
    const uploadPolicy = parseUploadPolicy(c.env);
    const payload = {
      version: WORKER_VERSION,
      auth: {
        accessEnabled: true,
        hmacAdminEnabled: true,
      },
      limits: {
        adminAuthWindowSec: getAdminAuthWindowSeconds(c.env),
        maxShareTtlSec: envInt(c.env.R2E_MAX_SHARE_TTL_SEC, 2592000),
        defaultShareTtlSec: envInt(c.env.R2E_DEFAULT_SHARE_TTL_SEC, 86400),
        uiMaxListLimit: envInt(c.env.R2E_UI_MAX_LIST_LIMIT, 1000),
        upload: {
          maxFileBytes: uploadPolicy.maxFileBytes,
          maxParts: uploadPolicy.maxParts,
          maxConcurrentPerUser: uploadPolicy.maxConcurrentPerUser,
          sessionTtlSec: uploadPolicy.sessionTtlSec,
          signPartTtlSec: uploadPolicy.signPartTtlSec,
          partSizeBytes: uploadPolicy.partSizeBytes,
          allowedMime: uploadPolicy.allowedMime,
          blockedMime: uploadPolicy.blockedMime,
          allowedExtensions: uploadPolicy.allowedExtensions,
          blockedExtensions: uploadPolicy.blockedExtensions,
          prefixAllowlist: uploadPolicy.prefixAllowlist,
        },
      },
      readonly: envBool(c.env.R2E_READONLY, false),
      bucket: {
        alias: "files" as const,
        binding: "FILES_BUCKET" as const,
      },
      buckets: listBucketBindings(c.env),
      share: {
        mode: "kv-random-token" as const,
        kvNamespace: "R2E_SHARES_KV" as const,
        keysetNamespace: "R2E_KEYS_KV" as const,
      },
      actor: requestActor(c),
    };
    return jsonValidated(serverInfoResponseSchema, payload);
  });

  app.get("/share/:token", async (c) => {
    const tokenId = decodeURIComponent(c.req.param("token"));
    if (!tokenId) {
      throw new HttpError(404, "share_not_found", "Share token missing.");
    }
    const record = await incrementShareDownload(c.env, tokenId);
    const { bucket: r2Bucket } = resolveBucket(c.env, record.bucket);
    const object = await getObject(r2Bucket, record.key);
    return responseFromObject(object, record.key, record.contentDisposition);
  });

  app.notFound(() => notFound());

  app.onError((error) => {
    if (error instanceof HttpError) {
      return apiError(error.status, error.code, error.message, error.details);
    }
    return apiError(500, "internal_error", "Unexpected worker error.", {
      message: String(error),
    });
  });

  return app;
}
