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

export function json(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

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

export async function readBodyText(request: Request): Promise<string> {
  return request.text();
}

export function parseJsonBody<T>(rawBody: string): T {
  if (rawBody.length === 0) {
    throw new HttpError(400, "bad_request", "Request body is required.");
  }
  try {
    return JSON.parse(rawBody) as T;
  } catch (error) {
    throw new HttpError(400, "bad_request", "Request body must be valid JSON.", {
      parseError: String(error),
    });
  }
}

export function methodNotAllowed(allowed: string[]): Response {
  return apiError(405, "method_not_allowed", `Method not allowed. Allowed methods: ${allowed.join(", ")}`);
}

export function notFound(message = "Resource not found."): Response {
  return apiError(404, "not_found", message);
}

export function contentDisposition(value: "attachment" | "inline", key: string): string {
  const filename = key.split("/").filter(Boolean).at(-1) ?? "file";
  return `${value}; filename="${sanitizeFilename(filename)}"`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n"]/g, "_");
}
