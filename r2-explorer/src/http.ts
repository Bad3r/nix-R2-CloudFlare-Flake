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

/** Build a Content-Disposition header value for an object key. */
export function contentDisposition(value: "attachment" | "inline", key: string): string {
  const filename = key.split("/").filter(Boolean).at(-1) ?? "file";
  return `${value}; filename="${sanitizeFilename(filename)}"`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n"]/g, "_");
}
