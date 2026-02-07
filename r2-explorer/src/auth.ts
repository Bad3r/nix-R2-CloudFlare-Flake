import { HttpError } from "./http";
import type { AccessIdentity, AdminKeyset, Env } from "./types";

const ADMIN_KEYSET_KV_KEY = "admin:keyset:active";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function getAdminAuthWindowSeconds(env: Env): number {
  return parsePositiveInt(env.R2E_ADMIN_AUTH_WINDOW_SEC, 300);
}

export function extractAccessIdentity(request: Request): AccessIdentity | null {
  const email = request.headers.get("cf-access-authenticated-user-email");
  const userId = request.headers.get("cf-access-authenticated-user-id");
  const jwt = request.headers.get("cf-access-jwt-assertion");

  if (!email && !userId && !jwt) {
    return null;
  }

  return { email, userId, jwt };
}

async function getAdminKeyset(env: Env): Promise<AdminKeyset> {
  const payload = await env.R2E_KEYS_KV.get(ADMIN_KEYSET_KV_KEY);
  if (!payload) {
    throw new HttpError(500, "admin_keyset_missing", `KV entry '${ADMIN_KEYSET_KV_KEY}' is missing.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw new HttpError(500, "admin_keyset_invalid", "Admin keyset is not valid JSON.", {
      parseError: String(error),
    });
  }

  const keyset = parsed as Partial<AdminKeyset>;
  if (
    !keyset ||
    typeof keyset.activeKid !== "string" ||
    !(
      keyset.previousKid === undefined ||
      keyset.previousKid === null ||
      typeof keyset.previousKid === "string"
    ) ||
    typeof keyset.updatedAt !== "string" ||
    !keyset.keys ||
    typeof keyset.keys !== "object"
  ) {
    throw new HttpError(500, "admin_keyset_invalid", "Admin keyset schema is invalid.");
  }

  return {
    activeKid: keyset.activeKid,
    previousKid: keyset.previousKid ?? null,
    updatedAt: keyset.updatedAt,
    keys: keyset.keys as Record<string, string>,
  };
}

function decodeKeyMaterial(raw: string): ArrayBuffer {
  let bytes: Uint8Array;
  if (raw.startsWith("base64:")) {
    const value = raw.slice("base64:".length);
    const decoded = atob(value);
    bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i += 1) {
      bytes[i] = decoded.charCodeAt(i);
    }
  } else {
    bytes = new TextEncoder().encode(raw);
  }

  const cloned = new Uint8Array(bytes.byteLength);
  cloned.set(bytes);
  return cloned.buffer;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const keyMaterial = decodeKeyMaterial(secret);
  const key = await crypto.subtle.importKey("raw", keyMaterial, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return toHex(new Uint8Array(signature));
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
}

function canonicalQueryString(url: URL): string {
  const entries: Array<[string, string]> = [];
  url.searchParams.forEach((value, key) => {
    entries.push([key, value]);
  });
  entries.sort(([aKey, aValue], [bKey, bValue]) => {
    if (aKey === bKey) {
      return aValue.localeCompare(bValue);
    }
    return aKey.localeCompare(bKey);
  });
  return entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

async function validateNonce(env: Env, kid: string, nonce: string, ttlSeconds: number): Promise<void> {
  const replayKey = `admin:nonce:${kid}:${nonce}`;
  const found = await env.R2E_KEYS_KV.get(replayKey);
  if (found !== null) {
    throw new HttpError(401, "admin_signature_replay", "Nonce has already been used.");
  }
  await env.R2E_KEYS_KV.put(replayKey, "1", { expirationTtl: ttlSeconds });
}

export async function verifyAdminSignature(request: Request, env: Env, rawBody: string): Promise<string> {
  const kid = request.headers.get("x-r2e-kid");
  const timestampHeader = request.headers.get("x-r2e-ts");
  const nonce = request.headers.get("x-r2e-nonce");
  const signatureHeader = request.headers.get("x-r2e-signature");

  if (!kid || !timestampHeader || !nonce || !signatureHeader) {
    throw new HttpError(
      401,
      "admin_signature_missing",
      "Missing admin signature headers (x-r2e-kid, x-r2e-ts, x-r2e-nonce, x-r2e-signature).",
    );
  }

  const timestamp = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(timestamp)) {
    throw new HttpError(401, "admin_signature_invalid", "x-r2e-ts must be a unix epoch integer.");
  }

  const now = Math.floor(Date.now() / 1000);
  const windowSec = getAdminAuthWindowSeconds(env);
  if (Math.abs(now - timestamp) > windowSec) {
    throw new HttpError(
      401,
      "admin_signature_expired",
      `x-r2e-ts outside allowed window of ${windowSec} seconds.`,
    );
  }

  const keyset = await getAdminKeyset(env);
  if (kid !== keyset.activeKid && kid !== keyset.previousKid) {
    throw new HttpError(401, "admin_signature_invalid", "Unknown or inactive key id.");
  }
  const secret = keyset.keys[kid];
  if (!secret) {
    throw new HttpError(401, "admin_signature_invalid", "Key id is not present in keyset map.");
  }

  const url = new URL(request.url);
  const query = canonicalQueryString(url);
  const bodyHash = await sha256Hex(rawBody);
  const canonicalPayload = `${request.method.toUpperCase()}\n${url.pathname}\n${query}\n${bodyHash}\n${timestamp}\n${nonce}`;
  const expected = await hmacSha256Hex(secret, canonicalPayload);
  const provided = signatureHeader.trim().toLowerCase();

  if (!constantTimeEquals(expected, provided)) {
    throw new HttpError(401, "admin_signature_invalid", "Signature validation failed.");
  }

  await validateNonce(env, kid, nonce, windowSec);
  return kid;
}

export async function requireApiIdentity(request: Request): Promise<AccessIdentity> {
  const identity = extractAccessIdentity(request);
  if (!identity) {
    throw new HttpError(
      401,
      "access_required",
      "Cloudflare Access identity is required for /api routes.",
    );
  }
  return identity;
}

export async function requireAccessOrAdminSignature(
  request: Request,
  env: Env,
  rawBody: string,
): Promise<{ mode: "access" | "hmac"; actor: string }> {
  const identity = extractAccessIdentity(request);
  if (identity) {
    const actor = identity.email ?? identity.userId ?? "access-user";
    return { mode: "access", actor };
  }

  const kid = await verifyAdminSignature(request, env, rawBody);
  return { mode: "hmac", actor: `hmac:${kid}` };
}
