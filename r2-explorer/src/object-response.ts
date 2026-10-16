import { contentDisposition } from "./http";
import { cancelUnreadBody } from "./r2";
import type { RangedObjectResult } from "./r2";

/** Strip leading slashes so object keys match their canonical R2 form. */
export function normalizeObjectKey(key: string): string {
  return key.replace(/^\/+/, "");
}

/** Reduce a Content-Type header to its lowercase media type without parameters. */
export function normalizeMimeType(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

/** Guess a Content-Type from an object key extension for untyped objects. */
export function guessContentType(key: string): string {
  const lower = key.toLowerCase();
  if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

/**
 * Decide whether /api/v2/preview may serve a content type inline. This is the
 * preview allowlist: text, images, PDF, and JSON render inline; everything
 * else downloads as an attachment.
 */
export function isInlinePreview(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }
  if (contentType.startsWith("text/")) {
    return true;
  }
  if (contentType.startsWith("image/")) {
    return true;
  }
  return contentType === "application/pdf" || contentType === "application/json";
}

const INLINE_SAFE_EXACT_TYPES = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
  "application/pdf",
]);

/**
 * Decide whether a content type can be rendered inline on the worker origin
 * without a neutralizing Content-Security-Policy. Script-capable types such
 * as text/html, image/svg+xml, and XML dialects are never inline-safe because
 * an inline render would execute stored markup as the worker origin.
 */
export function isInlineSafeContentType(contentType: string): boolean {
  const normalized = normalizeMimeType(contentType);
  if (INLINE_SAFE_EXACT_TYPES.has(normalized)) {
    return true;
  }
  if (normalized === "image/svg+xml") {
    return false;
  }
  if (
    normalized.startsWith("image/") ||
    normalized.startsWith("audio/") ||
    normalized.startsWith("video/") ||
    normalized.startsWith("font/")
  ) {
    return true;
  }
  return false;
}

export type RangedObjectResponseOptions = {
  /** Override the stored or guessed Content-Type on the response. */
  forceContentType?: string;
  /**
   * Response hardening profile. Both profiles send nosniff plus
   * `Content-Security-Policy: default-src 'none'; sandbox` unless the
   * response is inline with an inline-safe content type, so stored
   * script-capable documents (text/html, image/svg+xml, XML) never execute
   * on the worker origin. The inline-safe exemption keeps inline text, PDF,
   * and image renders working in browsers whose viewers refuse sandboxed
   * documents.
   * - "preview": authenticated /api/v2/preview responses.
   * - "strict": /api/v2/download and public /share/:token responses.
   */
  hardening: "preview" | "strict";
  /** False for HEAD: build the same headers and status as GET, but never stream a body. */
  includeBody: boolean;
};

function resolveContentRange(range: R2Range, size: number): { start: number; end: number } {
  // workerd reports { offset, length, suffix: undefined }: test the values, a key check is always true.
  const suffix = "suffix" in range ? range.suffix : undefined;
  if (typeof suffix === "number") {
    const start = Math.max(0, size - suffix);
    return { start, end: Math.max(size - 1, start) };
  }
  const offset = "offset" in range ? range.offset : undefined;
  const length = "length" in range ? range.length : undefined;
  const start = offset ?? 0;
  const end = typeof length === "number" ? start + length - 1 : Math.max(size - 1, start);
  return { start, end };
}

/**
 * Build the response for a Range/conditional-aware object read (the result
 * of r2.ts's getObjectForRead): 200 or 206 with a body, 304/412 with
 * metadata headers and no body, or 416 with only Content-Range.
 * Accept-Ranges: bytes is always sent so clients know Range is supported.
 * `includeBody: false` (a HEAD request) reuses the exact GET header set but
 * cancels object.body instead of streaming it, since Hono maps HEAD onto the
 * GET handler and R2 has no head()-with-onlyIf to answer HEAD without
 * calling get().
 */
export async function respondToRangedObject(
  result: RangedObjectResult,
  key: string,
  disposition: "attachment" | "inline",
  options: RangedObjectResponseOptions,
): Promise<Response> {
  const headers = new Headers();
  headers.set("accept-ranges", "bytes");

  if (result.kind === "unsatisfiable_range") {
    headers.set("content-range", `bytes */${result.size}`);
    return new Response(null, { status: 416, headers });
  }

  result.object.writeHttpMetadata(headers);
  headers.set("etag", result.object.httpEtag);
  headers.set("last-modified", result.object.uploaded.toUTCString());

  if (result.kind === "precondition_failed") {
    return new Response(null, { status: result.status, headers });
  }

  if (!headers.has("content-type")) {
    headers.set("content-type", options.forceContentType ?? guessContentType(key));
  } else if (options.forceContentType) {
    headers.set("content-type", options.forceContentType);
  }
  headers.set("content-disposition", contentDisposition(disposition, key));
  headers.set("cache-control", "private, max-age=0, no-store");
  headers.set("x-content-type-options", "nosniff");

  if (options.hardening === "strict" || options.hardening === "preview") {
    const effectiveType = headers.get("content-type") ?? "application/octet-stream";
    const inlineSafe = disposition === "inline" && isInlineSafeContentType(effectiveType);
    if (!inlineSafe) {
      headers.set("content-security-policy", "default-src 'none'; sandbox");
    }
  }

  if (result.status === 206 && result.object.range) {
    const { start, end } = resolveContentRange(result.object.range, result.object.size);
    headers.set("content-range", `bytes ${start}-${end}/${result.object.size}`);
    headers.set("content-length", `${end - start + 1}`);
  } else {
    headers.set("content-length", `${result.object.size}`);
  }

  if (!options.includeBody) {
    await cancelUnreadBody(result.object);
    return new Response(null, { status: result.status, headers });
  }
  return new Response(result.object.body, { status: result.status, headers });
}
