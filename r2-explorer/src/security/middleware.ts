import type { Hono, MiddlewareHandler } from "hono";
import type { AppContext } from "../app-context";
import {
  requiredReadScopes,
  requiredShareManageScopes,
  requiredWriteScopes,
  requireApiIdentity,
} from "../auth";
import { envBool } from "../config";
import { HttpError } from "../http";
import { assertUploadMutationGuards } from "./csrf";

/**
 * POST routes that mutate state and carry a JSON body. The same set drives
 * raw-body buffering and the cookie-auth Origin/CSRF guard; the two concerns
 * intentionally cover the same paths.
 */
export const API_MUTATION_PATHS: ReadonlySet<string> = new Set([
  "/api/v2/upload/init",
  "/api/v2/upload/sign-part",
  "/api/v2/upload/complete",
  "/api/v2/upload/abort",
  "/api/v2/object/delete",
  "/api/v2/object/move",
  "/api/v2/share/create",
  "/api/v2/share/revoke",
]);

const API_READ_PATHS = [
  "/api/v2/list",
  "/api/v2/meta",
  "/api/v2/download",
  "/api/v2/preview",
  "/api/v2/auth/bootstrap",
  "/api/v2/server/info",
  "/api/v2/session/info",
];

const API_WRITE_PATHS = [
  "/api/v2/upload/init",
  "/api/v2/upload/sign-part",
  "/api/v2/upload/complete",
  "/api/v2/upload/abort",
  "/api/v2/object/delete",
  "/api/v2/object/move",
];

const API_SHARE_MANAGE_PATHS = ["/api/v2/share/create", "/api/v2/share/revoke", "/api/v2/share/list"];

const accessReadMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const identity = await requireApiIdentity(c.req.raw, c.env, requiredReadScopes(c.env));
  c.set("actor", identity.email ?? identity.userId ?? "");
  c.set("authSource", identity.source);
  await next();
};

const accessWriteMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const identity = await requireApiIdentity(c.req.raw, c.env, requiredWriteScopes(c.env));
  c.set("actor", identity.email ?? identity.userId ?? "");
  c.set("authSource", identity.source);
  await next();
};

const shareManageMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const identity = await requireApiIdentity(c.req.raw, c.env, requiredShareManageScopes(c.env));
  c.set("actor", identity.email ?? identity.userId ?? "");
  c.set("authSource", identity.source);
  await next();
};

const cookieMutationGuardMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === "POST" && API_MUTATION_PATHS.has(c.req.path) && c.get("authSource") === "access_cookie") {
    assertUploadMutationGuards(c.req.raw, c.env);
  }
  await next();
};

/**
 * Register the /api/v2 middleware stack: request context defaults, the
 * readonly-mode guard, raw JSON body buffering, per-path Access scope
 * enforcement, and the cookie-auth Origin/CSRF guard for mutation routes.
 *
 * The readonly guard only covers /api/v2/*; the public /share/:token route
 * stays readable in readonly mode and applies its own no-write handling (see
 * src/share/service.ts).
 */
export function registerSecurityMiddleware(app: Hono<AppContext>): void {
  app.use("/api/v2/*", async (c, next) => {
    c.set("actor", "");
    c.set("rawBody", "");
    c.set("authSource", null);
    c.set("uploadPolicy", null);
    await next();
  });

  app.use("/api/v2/*", async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (envBool(c.env.R2E_READONLY, false) && method !== "GET" && method !== "HEAD") {
      throw new HttpError(403, "readonly_mode", "This explorer is in readonly mode.");
    }
    await next();
  });

  app.use("/api/v2/*", async (c, next) => {
    if (c.req.method.toUpperCase() === "POST" && API_MUTATION_PATHS.has(c.req.path)) {
      c.set("rawBody", await c.req.text());
    }
    await next();
  });

  for (const path of API_READ_PATHS) {
    app.use(path, accessReadMiddleware);
  }

  for (const path of API_WRITE_PATHS) {
    app.use(path, accessWriteMiddleware);
  }

  for (const path of API_SHARE_MANAGE_PATHS) {
    app.use(path, shareManageMiddleware);
  }

  for (const path of API_MUTATION_PATHS) {
    app.use(path, cookieMutationGuardMiddleware);
  }
}
