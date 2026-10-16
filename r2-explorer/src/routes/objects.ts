import type { Hono } from "hono";
import type { AppContext } from "../app-context";
import { envInt } from "../config";
import { HttpError } from "../http";
import {
  guessContentType,
  isInlinePreview,
  normalizeObjectKey,
  respondToRangedObject,
} from "../object-response";
import { backupObjectToTrash, getObjectForRead, headObject, listObjects, moveObject, softDeleteObject } from "../r2";
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

// Prefixes owned by systems outside this Worker's API. `.git-annex/` is the
// R2-side content store for the repo's git-annex special remote (see
// AGENTS.md's Architecture section); letting delete/move reach it can corrupt
// that remote for every clone without this Worker ever seeing it happen.
const RESERVED_KEY_PREFIXES = [UPLOAD_STAGING_PREFIX, ".git-annex/"];

function reservedPrefixError(action: "Delete" | "Move", code: string, key: string): HttpError | null {
  const prefix = RESERVED_KEY_PREFIXES.find((candidate) => key.startsWith(candidate));
  return prefix ? new HttpError(400, code, `${action} cannot touch the reserved prefix: ${prefix}`) : null;
}

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
    // Hono maps HEAD onto this GET handler and discards the body afterward
    // (c.req.method still reports HEAD here); Range never applies to HEAD,
    // since a HEAD response describes the whole resource regardless of Range.
    const isHead = c.req.method === "HEAD";
    const result = await getObjectForRead(c.env.FILES_BUCKET, key, c.req.raw.headers, { allowRange: !isHead });
    return respondToRangedObject(result, key, "attachment", { hardening: "strict", includeBody: !isHead });
  });

  app.get("/api/v2/preview", async (c) => {
    const query = validateSchema(metaQuerySchema, queryPayload(c.req.raw), "query");
    const key = normalizeObjectKey(query.key);
    const isHead = c.req.method === "HEAD";
    const result = await getObjectForRead(c.env.FILES_BUCKET, key, c.req.raw.headers, { allowRange: !isHead });
    const tempHeaders = new Headers();
    if (result.kind !== "unsatisfiable_range") {
      result.object.writeHttpMetadata(tempHeaders);
    }
    const sourceType = tempHeaders.get("content-type") ?? guessContentType(key);
    const inline = isInlinePreview(sourceType);
    return respondToRangedObject(result, key, inline ? "inline" : "attachment", {
      forceContentType: sourceType,
      hardening: "preview",
      includeBody: !isHead,
    });
  });

  app.post("/api/v2/object/delete", async (c) => {
    const body = readJsonBody(c, objectDeleteBodySchema);
    const key = normalizeObjectKey(body.key);
    // The staging area belongs to in-flight multipart uploads; letting delete
    // reach it would let a writer soft-delete another session's staged bytes
    // between completion and validation.
    const reservedError = reservedPrefixError("Delete", "invalid_delete", key);
    if (reservedError) {
      throw reservedError;
    }
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
    const reservedError =
      reservedPrefixError("Move", "invalid_move", fromKey) ?? reservedPrefixError("Move", "invalid_move", toKey);
    if (reservedError) {
      throw reservedError;
    }
    // Checked before the destination-exists probe below: otherwise a
    // self-move would find its own key and report object_exists instead of
    // the more specific invalid_move.
    if (fromKey === toKey) {
      throw new HttpError(400, "invalid_move", "Source and destination keys must be different.");
    }
    const existing = await headObject(c.env.FILES_BUCKET, toKey);
    if (existing) {
      if (!body.overwrite) {
        throw new HttpError(409, "object_exists", `Destination key already exists: ${toKey}`, { key: toKey });
      }
      // Back up without deleting: moveObject's own copy below replaces the
      // destination atomically, so a failed move leaves the prior
      // destination object exactly as it was (plus a redundant, harmless
      // trash copy), instead of the destination briefly holding nothing.
      await backupObjectToTrash(c.env.FILES_BUCKET, toKey);
    }
    // Without overwrite, createOnlyIfAbsent closes the race between the head
    // check above and this copy: a key created in between still fails with
    // object_exists instead of silently overwriting whatever landed there.
    await moveObject(c.env.FILES_BUCKET, fromKey, toKey, undefined, {
      createOnlyIfAbsent: !body.overwrite,
    });
    return jsonValidated(objectMoveResponseSchema, {
      fromKey,
      toKey,
    });
  });
}
