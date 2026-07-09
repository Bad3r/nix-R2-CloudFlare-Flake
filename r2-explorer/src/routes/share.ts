import type { Hono } from "hono";
import type { AppContext } from "../app-context";
import { resolveBucket } from "../buckets";
import { envBool, envInt } from "../config";
import { HttpError } from "../http";
import { getShareRecord, listSharesForObject, putShareRecord } from "../kv";
import { normalizeObjectKey, responseFromObject } from "../object-response";
import { getObject, headObject } from "../r2";
import { randomTokenId } from "../random";
import {
  shareCreateBodySchema,
  shareCreateResponseSchema,
  shareListQuerySchema,
  shareListResponseSchema,
  shareRevokeBodySchema,
  shareRevokeResponseSchema,
} from "../schemas";
import { loadServableShare, recordShareDownload } from "../share/service";
import type { Env, ShareRecord } from "../types";
import { jsonValidated, queryPayload, readJsonBody, validateSchema } from "../validate";

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

function baseUrl(request: Request, env: Env): string {
  if (env.R2E_PUBLIC_BASE_URL && env.R2E_PUBLIC_BASE_URL.trim().length > 0) {
    return env.R2E_PUBLIC_BASE_URL.replace(/\/+$/, "");
  }
  return new URL(request.url).origin;
}

/**
 * Register the share-manage routes (create/revoke/list) and the public
 * GET /share/:token download route.
 */
export function registerShareRoutes(app: Hono<AppContext>): void {
  app.post("/api/v2/share/create", async (c) => {
    const body = readJsonBody(c, shareCreateBodySchema);
    const key = normalizeObjectKey(body.key);
    const bucketAlias = body.bucket ?? "files";
    const { bucket: r2Bucket } = resolveBucket(c.env, bucketAlias);
    const exists = await headObject(r2Bucket, key);
    if (!exists) {
      throw new HttpError(404, "object_not_found", `Object not found: ${key}`);
    }

    const maxTtl = envInt("R2E_MAX_SHARE_TTL_SEC", c.env.R2E_MAX_SHARE_TTL_SEC, 2592000);
    const defaultTtl = envInt("R2E_DEFAULT_SHARE_TTL_SEC", c.env.R2E_DEFAULT_SHARE_TTL_SEC, 86400);
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

  app.post("/api/v2/share/revoke", async (c) => {
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

  app.get("/api/v2/share/list", async (c) => {
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

  app.get("/share/:token", async (c) => {
    let tokenId: string;
    try {
      tokenId = decodeURIComponent(c.req.param("token"));
    } catch {
      // Malformed percent-encoding (e.g. GET /share/%) throws URIError, which
      // is not a valid token, not a server fault.
      throw new HttpError(404, "share_not_found", "Share token malformed.");
    }
    if (!tokenId) {
      throw new HttpError(404, "share_not_found", "Share token missing.");
    }
    const record = await loadServableShare(c.env, tokenId);
    // This route sits outside the /api/v2 readonly middleware on purpose:
    // readonly mode keeps serving shares but must not write to KV or Durable
    // Object storage, so download accounting (and therefore maxDownloads
    // decrementing) is skipped while R2E_READONLY is enabled.
    const readonly = envBool(c.env.R2E_READONLY, false);
    const effective = await recordShareDownload(c.env, record, { readonly });
    const { bucket: r2Bucket } = resolveBucket(c.env, effective.bucket);
    const object = await getObject(r2Bucket, effective.key);
    return responseFromObject(object, effective.key, effective.contentDisposition, { hardening: "strict" });
  });
}
