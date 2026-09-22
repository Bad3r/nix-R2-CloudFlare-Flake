import { ApiError } from "./api";
import type { ObjectMetadata, SessionInfoResponse } from "./api";

/**
 * Human-readable byte size using binary units.
 * Returns "-" for non-finite or negative input so table cells never show NaN.
 */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "-";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 ** 2) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  if (value < 1024 ** 3) {
    return `${(value / 1024 ** 2).toFixed(2)} MiB`;
  }
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

/** Locale timestamp for an ISO string; echoes the raw value when unparseable. */
export function formatWhen(value: string | null): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

/** Compact relative label (e.g. "3m ago") for the activity log. */
export function formatRelative(value: string): string {
  const date = new Date(value);
  const then = date.getTime();
  if (Number.isNaN(then)) {
    return value;
  }
  const deltaMs = Date.now() - then;
  const seconds = Math.round(deltaMs / 1000);
  if (seconds < 5) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return date.toLocaleDateString();
}

/** Parent prefix of a delimited key, or "" at the root. */
export function parentPrefix(prefix: string): string {
  if (!prefix) {
    return "";
  }
  const clean = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const index = clean.lastIndexOf("/");
  if (index === -1) {
    return "";
  }
  return `${clean.slice(0, index + 1)}`;
}

/** Trailing segment of a delimited prefix for breadcrumb display. */
export function prefixLabel(prefix: string): string {
  const clean = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const index = clean.lastIndexOf("/");
  return index === -1 ? clean : clean.slice(index + 1);
}

/** First issue's "path: message" from a validation_error's details.issues, if shaped as expected. */
function firstValidationIssue(details: unknown): string | null {
  if (typeof details !== "object" || details === null) {
    return null;
  }
  const issues = (details as { issues?: unknown }).issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return null;
  }
  const issue = issues[0] as { path?: unknown; message?: unknown };
  const message = typeof issue.message === "string" ? issue.message : null;
  if (!message) {
    return null;
  }
  const path = Array.isArray(issue.path) ? issue.path.join(".") : "";
  return path ? `${path}: ${message}` : message;
}

/**
 * Human message for any thrown value, appending a stable code for ApiError.
 * validation_error's own message is a fixed "Invalid X." boilerplate, so the
 * first Zod issue (the actual reason) is used instead when present.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "validation_error") {
      const issue = firstValidationIssue(error.details);
      if (issue) {
        return `${issue} (${error.code})`;
      }
    }
    return `${error.message} (${error.code})`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** True when the error is a 409 conflict because the target key already exists. */
export function isObjectExistsError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409 && error.code === "object_exists";
}

/** The conflicting key from an object_exists error's details, if present. */
export function objectExistsKey(error: ApiError): string | null {
  const details = error.details;
  if (typeof details !== "object" || details === null) {
    return null;
  }
  const key = (details as { key?: unknown }).key;
  return typeof key === "string" && key.length > 0 ? key : null;
}

/** True when the error is an Access/token 401 that requires re-authentication. */
export function isAuthRequired(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status === 401 &&
    // The worker's 401 family: access_required plus every token_invalid*
    // variant (token_invalid, token_invalid_signature). Prefix-matching keeps
    // key-rotation failures on the sign-in affordance instead of a dead end.
    (error.code === "access_required" || error.code.startsWith("token_invalid"))
  );
}

/** Strip the surrounding quotes R2 wraps around ETags. */
export function readEtag(object: ObjectMetadata): string {
  return object.etag.replace(/^"|"$/g, "");
}

/** Short display form for a possibly long object key (keeps head and tail). */
export function ellipsizeMiddle(value: string, max = 48): string {
  if (value.length <= max) {
    return value;
  }
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

const SHARE_TTL_PATTERN = /^[0-9]+[smhd]$/;

/**
 * Validate and normalize a share TTL field value. A bare number is rejected
 * here (the server would silently treat it as seconds) rather than forwarded;
 * an empty value falls back to the same "24h" default the API would apply.
 */
export function normalizeShareTtl(input: string): { ok: true; value: string } | { ok: false; message: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: true, value: "24h" };
  }
  if (!SHARE_TTL_PATTERN.test(trimmed)) {
    return { ok: false, message: "Enter a duration with a unit: s, m, h, or d (for example 24h)." };
  }
  return { ok: true, value: trimmed };
}

/** Parse the share max-downloads field, defaulting to 1 for blank/invalid input. */
export function parseMaxDownloads(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
}

/** Object-list page size from session limits, or the given default when absent. */
export function resolveListLimit(session: SessionInfoResponse | null, fallback = 200): number {
  return session?.limits.uiMaxListLimit ?? fallback;
}

/** True when the object table should show its "no objects under this prefix" state. */
export function isListingEmpty(loading: boolean, folderCount: number, objectCount: number): boolean {
  return !loading && folderCount === 0 && objectCount === 0;
}

export type FocusableRow = { kind: "folder"; value: string } | { kind: "object"; value: string } | null;

/**
 * The one row a roving-tabindex table keeps in the Tab order: the selected
 * object if one exists and is still listed, else the first row overall
 * (folders are listed before objects).
 */
export function focusableRow(folders: string[], objectKeys: string[], selectedKey: string | null): FocusableRow {
  if (selectedKey !== null && objectKeys.includes(selectedKey)) {
    return { kind: "object", value: selectedKey };
  }
  if (folders.length > 0) {
    return { kind: "folder", value: folders[0] };
  }
  if (objectKeys.length > 0) {
    return { kind: "object", value: objectKeys[0] };
  }
  return null;
}

/** HTML `accept` attribute value from allowed extensions/MIME types; empty when both are empty. */
export function buildAcceptAttribute(allowedExtensions: string[], allowedMime: string[]): string {
  const extensionTokens = allowedExtensions
    .map((ext) => ext.trim())
    .filter((ext) => ext.length > 0)
    .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`));
  const mimeTokens = allowedMime.map((mime) => mime.trim()).filter((mime) => mime.length > 0);
  return [...extensionTokens, ...mimeTokens].join(",");
}
