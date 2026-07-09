import { ApiError } from "./api";
import type { ObjectMetadata } from "./api";

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

/** Human message for any thrown value, appending a stable code for ApiError. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message} (${error.code})`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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
