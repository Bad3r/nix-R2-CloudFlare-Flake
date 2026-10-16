import type { ApiErrorPayload } from "./types";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Serialize data as a JSON response with no-store caching semantics. */
export function json(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

/** Build the standard machine-readable API error envelope. */
export function apiError(status: number, code: string, message: string, details?: unknown): Response {
  const payload: ApiErrorPayload = {
    error: {
      code,
      message,
      details,
    },
  };
  return json(payload, { status });
}

/**
 * Parse a raw JSON request body. This is the single JSON body parser shared
 * by the Hono routes and the Durable Object handlers; it rejects empty and
 * malformed bodies with client-safe 400 errors.
 */
export function parseJsonText(rawBody: string): unknown {
  if (rawBody.trim().length === 0) {
    throw new HttpError(400, "bad_request", "Request body is required.");
  }
  try {
    return JSON.parse(rawBody) as unknown;
  } catch (error) {
    throw new HttpError(400, "bad_request", "Request body must be valid JSON.", {
      parseError: String(error),
    });
  }
}

/** Build the standard 404 API error response. */
export function notFound(message = "Resource not found."): Response {
  return apiError(404, "not_found", message);
}

/**
 * Build a Content-Disposition header value for an object key. `Headers.set()`
 * converts values to a ByteString and throws for any UTF-16 code unit above
 * 255, so a plain `filename="..."` cannot carry non-Latin-1 names. Names with
 * non-ASCII characters get an ASCII-safe `filename=` fallback plus the RFC
 * 6266 / RFC 5987 `filename*=UTF-8''<percent-encoded>` extended parameter,
 * which modern clients prefer and old ones ignore.
 */
export function contentDisposition(value: "attachment" | "inline", key: string): string {
  const filename = key.split("/").filter(Boolean).at(-1) ?? "file";
  const sanitized = sanitizeFilename(filename);
  const fallback = `${value}; filename="${asciiFallbackFilename(sanitized)}"`;
  return isAscii(sanitized) ? fallback : `${fallback}; filename*=UTF-8''${encodeRfc5987(sanitized)}`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n"\\]/g, "_");
}

function isAscii(name: string): boolean {
  return /^[\x00-\x7f]*$/.test(name);
}

/** Replace non-ASCII code points with '_' for the plain filename= fallback. */
function asciiFallbackFilename(name: string): string {
  return Array.from(name)
    .map((char) => (char.codePointAt(0)! > 0x7f ? "_" : char))
    .join("");
}

/** RFC 5987 percent-encoding: encodeURIComponent leaves a few sub-delims unescaped that ext-value requires escaped. */
function encodeRfc5987(name: string): string {
  return encodeURIComponent(name).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
