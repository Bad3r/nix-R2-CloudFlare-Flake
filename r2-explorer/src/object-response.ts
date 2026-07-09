import { contentDisposition } from "./http";

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

export type ObjectResponseOptions = {
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
};

/**
 * Build the streaming response for a stored R2 object with content-type,
 * disposition, cache, and content-sniffing/CSP hardening headers applied.
 * All object responses send `X-Content-Type-Options: nosniff` so browsers
 * cannot sniff stored bytes into a script-capable type.
 */
export async function responseFromObject(
  object: R2ObjectBody,
  key: string,
  disposition: "attachment" | "inline",
  options: ObjectResponseOptions,
): Promise<Response> {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
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

  return new Response(object.body, { status: 200, headers });
}
