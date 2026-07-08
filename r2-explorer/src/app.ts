import { Hono } from "hono";
import type { AppContext } from "./app-context";
import { apiError, HttpError, notFound } from "./http";
import { registerObjectRoutes } from "./routes/objects";
import { registerServerInfoRoutes } from "./routes/server-info";
import { registerShareRoutes } from "./routes/share";
import { registerUploadRoutes } from "./routes/upload";
import { registerSecurityMiddleware } from "./security/middleware";

/**
 * Build the worker Hono app: /api/v2 middleware stack, object routes, upload
 * control-plane routes, share routes (including public /share/:token), and
 * the server-info routes. Route handlers live in src/routes/*.
 */
export function createApp(): Hono<AppContext> {
  const app = new Hono<AppContext>();

  registerSecurityMiddleware(app);
  registerObjectRoutes(app);
  registerUploadRoutes(app);
  registerShareRoutes(app);
  registerServerInfoRoutes(app);

  app.notFound(() => notFound());

  app.onError((error) => {
    if (error instanceof HttpError) {
      return apiError(error.status, error.code, error.message, error.details);
    }
    // Unexpected errors are logged with full detail for observability but
    // surface to clients as a stable generic code so internals never leak.
    console.error("Unhandled worker error:", error);
    return apiError(500, "internal_error", "Unexpected worker error.");
  });

  return app;
}
