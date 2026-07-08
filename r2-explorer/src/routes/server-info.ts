import type { Context, Hono } from "hono";
import type { AppContext } from "../app-context";
import { listBucketBindings } from "../buckets";
import { envBool, envInt } from "../config";
import { serverInfoResponseSchema } from "../schemas";
import { getUploadPolicy } from "../upload/policy";
import { jsonValidated, requestActor } from "../validate";
import { WORKER_VERSION } from "../version";

/**
 * Register the informational routes: server/session info plus the
 * auth bootstrap redirect used to warm the Access session cookie.
 */
export function registerServerInfoRoutes(app: Hono<AppContext>): void {
  const serverInfoHandler = async (c: Context<AppContext>) => {
    const uploadPolicy = getUploadPolicy(c);
    const payload = {
      version: WORKER_VERSION,
      auth: {
        accessEnabled: true,
      },
      limits: {
        maxShareTtlSec: envInt("R2E_MAX_SHARE_TTL_SEC", c.env.R2E_MAX_SHARE_TTL_SEC, 2592000),
        defaultShareTtlSec: envInt("R2E_DEFAULT_SHARE_TTL_SEC", c.env.R2E_DEFAULT_SHARE_TTL_SEC, 86400),
        uiMaxListLimit: envInt("R2E_UI_MAX_LIST_LIMIT", c.env.R2E_UI_MAX_LIST_LIMIT, 1000),
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
      },
      actor: requestActor(c),
    };
    return jsonValidated(serverInfoResponseSchema, payload);
  };

  app.get("/api/v2/auth/bootstrap", (c) => c.redirect("/", 302));
  app.get("/api/v2/server/info", serverInfoHandler);
  app.get("/api/v2/session/info", serverInfoHandler);
}
