import { parseList } from "../config";
import { HttpError } from "../http";
import type { Env } from "../types";

/**
 * Parse and validate an Origin header value, rejecting missing, opaque, and
 * non-http(s) origins with 403 errors.
 */
export function parseOrigin(origin: string | null): string {
  if (!origin || origin.trim().length === 0) {
    throw new HttpError(403, "origin_required", "Origin header is required for cookie-authenticated mutation routes.");
  }
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("origin protocol must be http or https");
    }
    if (parsed.origin === "null") {
      throw new Error("origin must be a concrete web origin");
    }
    return parsed.origin;
  } catch {
    throw new HttpError(403, "origin_invalid", "Origin header is not a valid URL origin.");
  }
}

/**
 * Resolve the set of origins allowed to invoke cookie-authenticated mutation
 * routes. Defaults to the request origin when R2E_UPLOAD_ALLOWED_ORIGINS is
 * not configured.
 */
export function parseAllowedOrigins(env: Env, requestOrigin: string): Set<string> {
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

/**
 * Enforce the Origin allowlist plus the custom x-r2e-csrf header on
 * cookie-authenticated mutation requests. The configured origin allowlist is
 * logged, not echoed, so rejected callers cannot enumerate deployment config.
 */
export function assertUploadMutationGuards(request: Request, env: Env): void {
  const requestOrigin = new URL(request.url).origin;
  const origin = parseOrigin(request.headers.get("origin"));
  const allowedOrigins = parseAllowedOrigins(env, requestOrigin);
  if (!allowedOrigins.has(origin)) {
    console.error(
      `Rejected cookie-authenticated mutation from origin ${origin}; allowed origins: ${[...allowedOrigins].join(", ")}`,
    );
    throw new HttpError(403, "origin_not_allowed", "Origin is not allowed for cookie-authenticated mutation route.", {
      origin,
    });
  }

  const csrf = request.headers.get("x-r2e-csrf");
  if (!csrf || csrf.trim() !== "1") {
    throw new HttpError(403, "csrf_required", "Missing required x-r2e-csrf header for cookie-authenticated mutation route.");
  }
}
