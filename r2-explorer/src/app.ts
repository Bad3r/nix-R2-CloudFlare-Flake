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
  uploadMultipartPart,
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
  uploadPartQuerySchema,
  uploadPartResponseSchema,
} from "./schemas";
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

const BASE62_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const JSON_BODY_PATHS = new Set([
  "/api/upload/init",
  "/api/upload/complete",
  "/api/upload/abort",
  "/api/object/delete",
  "/api/object/move",
  "/api/share/create",
  "/api/share/revoke",
]);

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

function normalizeObjectKey(key: string): string {
  return key.replace(/^\/+/, "");
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
  c.set("actor", identity.email ?? identity.userId ?? "access-user");
  c.set("authMode", "access");
  await next();
};

// Accepts either Access JWT or HMAC admin signature.  The `/api/*`
// catch-all middleware runs first and sets `accessIdentity` via the
// lightweight `extractAccessIdentity` (header sniff only).  When
// headers are present we promote to full JWT verification; otherwise
// we fall through to HMAC signature validation.
const accessOrHmacMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  if (c.get("accessIdentity")) {
    const identity = await requireApiIdentity(c.req.raw, c.env);
    c.set("accessIdentity", identity);
    c.set("actor", identity.email ?? identity.userId ?? "access-user");
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
    "/api/upload/part",
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
    const key = normalizeObjectKey(body.key);
    const upload = await createMultipartUpload(c.env.FILES_BUCKET, key, body.contentType);
    return jsonValidated(uploadInitResponseSchema, {
      key: upload.key,
      uploadId: upload.uploadId,
    });
  });

  app.post("/api/upload/part", async (c) => {
    const query = validateSchema(uploadPartQuerySchema, queryPayload(c.req.raw), "query");
    const payload = await c.req.arrayBuffer();
    const part = await uploadMultipartPart(
      c.env.FILES_BUCKET,
      normalizeObjectKey(query.key),
      query.uploadId,
      query.partNumber,
      payload,
    );
    return jsonValidated(uploadPartResponseSchema, {
      partNumber: part.partNumber,
      etag: part.etag,
    });
  });

  app.post("/api/upload/complete", async (c) => {
    const body = readJsonBody(c, uploadCompleteBodySchema);
    const object = await completeMultipartUpload(
      c.env.FILES_BUCKET,
      normalizeObjectKey(body.key),
      body.uploadId,
      body.parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
    );
    return jsonValidated(uploadCompleteResponseSchema, {
      key: object.key,
      etag: object.etag,
      uploaded: object.uploaded ? object.uploaded.toISOString() : null,
      size: object.size,
    });
  });

  app.post("/api/upload/abort", async (c) => {
    const body = readJsonBody(c, uploadAbortBodySchema);
    await abortMultipartUpload(c.env.FILES_BUCKET, normalizeObjectKey(body.key), body.uploadId);
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
