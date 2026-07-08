import type { Hono } from "hono";
import type { AppContext } from "../app-context";
import { envInt } from "../config";
import { HttpError } from "../http";
import {
  guessContentType,
  isInlinePreview,
  normalizeObjectKey,
  responseFromObject,
} from "../object-response";
import { getObject, headObject, listObjects, moveObject, softDeleteObject } from "../r2";
import {
  listQuerySchema,
  listResponseSchema,
  metaQuerySchema,
  metaResponseSchema,
  objectDeleteBodySchema,
  objectDeleteResponseSchema,
  objectMoveBodySchema,
  objectMoveResponseSchema,
} from "../schemas";
import { UPLOAD_STAGING_PREFIX } from "./upload";
import { jsonValidated, queryPayload, readJsonBody, requestActor, validateSchema } from "../validate";

/**
 * Register the object routes: GET list/meta/download/preview and the POST
 * delete/move mutations.
 */
export function registerObjectRoutes(app: Hono<AppContext>): void {
  app.get("/api/v2/list", async (c) => {
    const query = validateSchema(listQuerySchema, queryPayload(c.req.raw), "query");
    const configuredLimit = envInt("R2E_UI_MAX_LIST_LIMIT", c.env.R2E_UI_MAX_LIST_LIMIT, 1000);
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

  app.get("/api/v2/meta", async (c) => {
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

  app.get("/api/v2/download", async (c) => {
    const query = validateSchema(metaQuerySchema, queryPayload(c.req.raw), "query");
    const key = normalizeObjectKey(query.key);
    const object = await getObject(c.env.FILES_BUCKET, key);
    return responseFromObject(object, key, "attachment", { hardening: "strict" });
  });

  app.get("/api/v2/preview", async (c) => {
    const query = validateSchema(metaQuerySchema, queryPayload(c.req.raw), "query");
    const key = normalizeObjectKey(query.key);
    const object = await getObject(c.env.FILES_BUCKET, key);
    const tempHeaders = new Headers();
    object.writeHttpMetadata(tempHeaders);
    const sourceType = tempHeaders.get("content-type") ?? guessContentType(key);
    const inline = isInlinePreview(sourceType);
    return responseFromObject(object, key, inline ? "inline" : "attachment", {
      forceContentType: sourceType,
      hardening: "preview",
    });
  });

  app.post("/api/v2/object/delete", async (c) => {
    const body = readJsonBody(c, objectDeleteBodySchema);
    const key = normalizeObjectKey(body.key);
    const result = await softDeleteObject(c.env.FILES_BUCKET, key);
    return jsonValidated(objectDeleteResponseSchema, {
      key,
      trashKey: result.trashKey,
    });
  });

  app.post("/api/v2/object/move", async (c) => {
    const body = readJsonBody(c, objectMoveBodySchema);
    const fromKey = normalizeObjectKey(body.fromKey);
    const toKey = normalizeObjectKey(body.toKey);
    // The staging area belongs to in-flight multipart uploads; letting move
    // read or write it would allow tampering with another session's staged
    // bytes between completion and validation.
    if (fromKey.startsWith(UPLOAD_STAGING_PREFIX) || toKey.startsWith(UPLOAD_STAGING_PREFIX)) {
      throw new HttpError(400, "invalid_move", `Move cannot touch the reserved upload staging prefix: ${UPLOAD_STAGING_PREFIX}`);
    }
    await moveObject(c.env.FILES_BUCKET, fromKey, toKey);
    return jsonValidated(objectMoveResponseSchema, {
      fromKey,
      toKey,
    });
  });
}
