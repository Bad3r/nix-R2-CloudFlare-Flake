import { envInt, envNonNegativeInt, parseList } from "../config";
import { HttpError } from "../http";
import { normalizeMimeType } from "../object-response";
import type { Env } from "../types";

export type UploadPolicy = {
  bucketName: string;
  maxFileBytes: number;
  maxParts: number;
  maxConcurrentPerUser: number;
  sessionTtlSec: number;
  signPartTtlSec: number;
  partSizeBytes: number;
  allowedMime: string[];
  blockedMime: string[];
  allowedExtensions: string[];
  blockedExtensions: string[];
  prefixAllowlist: string[];
};

export const R2_MAX_UPLOAD_PARTS = 10_000;
export const R2_MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;
export const R2_MAX_PART_SIZE_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_UPLOAD_PART_SIZE_BYTES = 8 * 1024 * 1024;
const DEFAULT_UPLOAD_SESSION_TTL_SEC = 3600;
const DEFAULT_UPLOAD_SIGN_TTL_SEC = 60;

/**
 * Normalize a client-supplied upload prefix: strips leading slashes, rejects
 * path traversal and backslashes, and guarantees a trailing slash.
 */
export function normalizeUploadPrefix(prefix: string | undefined): string {
  if (!prefix || prefix.trim().length === 0) {
    return "";
  }

  const normalized = prefix.trim().replace(/^\/+/, "");
  if (normalized.includes("..")) {
    throw new HttpError(400, "invalid_upload_prefix", "Upload prefix cannot contain '..'.");
  }
  if (normalized.includes("\\")) {
    throw new HttpError(400, "invalid_upload_prefix", "Upload prefix cannot contain backslashes.");
  }
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

/**
 * Extract the lowercase dotted extension from a filename, or an empty string
 * when the filename has no simple alphanumeric extension.
 */
export function extractExtension(filename: string): string {
  const index = filename.lastIndexOf(".");
  if (index <= 0 || index >= filename.length - 1) {
    return "";
  }
  const extension = filename.slice(index).toLowerCase();
  if (!/^\.[a-z0-9]+$/.test(extension)) {
    return "";
  }
  return extension;
}

/**
 * Normalize one configured extension entry to a lowercase dotted form,
 * failing fast on entries that are not simple alphanumeric extensions.
 */
export function normalizeAllowedExtension(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (!lower) {
    return "";
  }
  const withDot = lower.startsWith(".") ? lower : `.${lower}`;
  if (!/^\.[a-z0-9]+$/.test(withDot)) {
    throw new HttpError(500, "upload_config_invalid", `Invalid extension in R2E_UPLOAD_ALLOWED_EXT: ${raw}`);
  }
  return withDot;
}

/** Require the S3-compatible bucket name used for signed part URLs. */
export function requireUploadBucketName(env: Env): string {
  const bucketName = env.R2E_UPLOAD_S3_BUCKET?.trim();
  if (!bucketName) {
    throw new HttpError(
      500,
      "upload_config_invalid",
      "Missing required Worker variable R2E_UPLOAD_S3_BUCKET for upload signing.",
    );
  }
  return bucketName;
}

/**
 * Parse the upload policy from Worker variables, failing fast with
 * upload_config_invalid on malformed values. Prefer getUploadPolicy inside
 * request handlers so the policy is parsed at most once per request.
 */
export function parseUploadPolicy(env: Env): UploadPolicy {
  const configuredMaxParts = envNonNegativeInt(
    "R2E_UPLOAD_MAX_PARTS",
    env.R2E_UPLOAD_MAX_PARTS,
    0,
    "upload_config_invalid",
  );
  const maxParts = configuredMaxParts === 0 ? R2_MAX_UPLOAD_PARTS : Math.min(configuredMaxParts, R2_MAX_UPLOAD_PARTS);

  const configuredPartSize = envInt(
    "R2E_UPLOAD_PART_SIZE_BYTES",
    env.R2E_UPLOAD_PART_SIZE_BYTES,
    DEFAULT_UPLOAD_PART_SIZE_BYTES,
    "upload_config_invalid",
  );
  if (configuredPartSize < R2_MIN_PART_SIZE_BYTES || configuredPartSize > R2_MAX_PART_SIZE_BYTES) {
    throw new HttpError(
      500,
      "upload_config_invalid",
      `R2E_UPLOAD_PART_SIZE_BYTES must be between ${R2_MIN_PART_SIZE_BYTES} and ${R2_MAX_PART_SIZE_BYTES}.`,
    );
  }

  const allowedMime = Array.from(new Set(parseList(env.R2E_UPLOAD_ALLOWED_MIME).map(normalizeMimeType)));
  const blockedMime = Array.from(new Set(parseList(env.R2E_UPLOAD_BLOCKED_MIME).map(normalizeMimeType)));
  const allowedExtensions = Array.from(
    new Set(
      parseList(env.R2E_UPLOAD_ALLOWED_EXT)
        .map(normalizeAllowedExtension)
        .filter((extension) => extension.length > 0),
    ),
  );
  const blockedExtensions = Array.from(
    new Set(
      parseList(env.R2E_UPLOAD_BLOCKED_EXT)
        .map(normalizeAllowedExtension)
        .filter((extension) => extension.length > 0),
    ),
  );
  const prefixAllowlist = Array.from(
    new Set(
      parseList(env.R2E_UPLOAD_PREFIX_ALLOWLIST)
        .map((prefix) => normalizeUploadPrefix(prefix))
        .filter((prefix) => prefix.length > 0),
    ),
  );

  return {
    bucketName: requireUploadBucketName(env),
    maxFileBytes: envNonNegativeInt(
      "R2E_UPLOAD_MAX_FILE_BYTES",
      env.R2E_UPLOAD_MAX_FILE_BYTES,
      0,
      "upload_config_invalid",
    ),
    maxParts,
    maxConcurrentPerUser: envNonNegativeInt(
      "R2E_UPLOAD_MAX_CONCURRENT_PER_USER",
      env.R2E_UPLOAD_MAX_CONCURRENT_PER_USER,
      0,
      "upload_config_invalid",
    ),
    sessionTtlSec: envInt(
      "R2E_UPLOAD_SESSION_TTL_SEC",
      env.R2E_UPLOAD_SESSION_TTL_SEC,
      DEFAULT_UPLOAD_SESSION_TTL_SEC,
      "upload_config_invalid",
    ),
    signPartTtlSec: envInt(
      "R2E_UPLOAD_SIGN_TTL_SEC",
      env.R2E_UPLOAD_SIGN_TTL_SEC,
      DEFAULT_UPLOAD_SIGN_TTL_SEC,
      "upload_config_invalid",
    ),
    partSizeBytes: configuredPartSize,
    allowedMime,
    blockedMime,
    allowedExtensions,
    blockedExtensions,
    prefixAllowlist,
  };
}

type UploadPolicyContext = {
  env: Env;
  get: (key: "uploadPolicy") => UploadPolicy | null;
  set: (key: "uploadPolicy", value: UploadPolicy | null) => void;
};

/**
 * Return the upload policy for the current request, parsing it on first use
 * and caching it in the request context. The cache is per request (not per
 * isolate) because Worker variables can differ between test environments.
 */
export function getUploadPolicy(c: UploadPolicyContext): UploadPolicy {
  const cached = c.get("uploadPolicy");
  if (cached) {
    return cached;
  }
  const policy = parseUploadPolicy(c.env);
  c.set("uploadPolicy", policy);
  return policy;
}
