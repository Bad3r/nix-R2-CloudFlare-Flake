import { HttpError } from "./http";
import type { AccessIdentity, AdminKeyset, Env } from "./types";

const ADMIN_KEYSET_KV_KEY = "admin:keyset:active";
const ACCESS_JWKS_CACHE_TTL_MS = 5 * 60 * 1000;

type AccessJwtHeader = {
  alg?: unknown;
  kid?: unknown;
};

type AccessJwtPayload = {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  sub?: unknown;
  email?: unknown;
};

type AccessJwk = JsonWebKey & {
  kid?: string;
};

type CachedAccessSigningKeys = {
  fetchedAtMs: number;
  keysByKid: Map<string, CryptoKey>;
  fallbackKey: CryptoKey | null;
};

const accessSigningKeyCache = new Map<string, CachedAccessSigningKeys>();

/** Clear the JWKS signing key cache. Exported for test teardown. */
export function resetAccessSigningKeyCache(): void {
  accessSigningKeyCache.clear();
}

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

function extractAccessJwtFromCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;

    const name = trimmed.slice(0, eq).trim();
    const rawValue = trimmed.slice(eq + 1).trim();
    if (!name || !rawValue) continue;

    if (name === "CF_Authorization" || name.startsWith("CF_Authorization_")) {
      const unquoted = rawValue.replace(/^"(.*)"$/, "$1");
      return unquoted.trim() || null;
    }
  }
  return null;
}

export function extractAccessIdentity(request: Request): AccessIdentity | null {
  const email = request.headers.get("cf-access-authenticated-user-email");
  const userId = request.headers.get("cf-access-authenticated-user-id");
  const jwt =
    request.headers.get("cf-access-jwt-assertion") ?? extractAccessJwtFromCookie(request.headers.get("cookie"));

  if (!email && !userId && !jwt) {
    return null;
  }

  return { email, userId, jwt };
}

function normalizeAccessTeamDomain(env: Env): string {
  const raw = env.R2E_ACCESS_TEAM_DOMAIN?.trim() ?? "";
  if (raw.length === 0) {
    throw new HttpError(
      500,
      "access_config_invalid",
      "Missing required Worker variable R2E_ACCESS_TEAM_DOMAIN for Access JWT validation.",
    );
  }

  const withoutScheme = raw.replace(/^https?:\/\//i, "");
  if (!/^[a-z0-9.-]+$/i.test(withoutScheme) || withoutScheme.includes("/")) {
    throw new HttpError(
      500,
      "access_config_invalid",
      "R2E_ACCESS_TEAM_DOMAIN must be a hostname like team.cloudflareaccess.com.",
    );
  }
  return withoutScheme.toLowerCase();
}

function requiredAccessAudience(env: Env): string {
  const aud = env.R2E_ACCESS_AUD?.trim() ?? "";
  if (aud.length === 0) {
    throw new HttpError(
      500,
      "access_config_invalid",
      "Missing required Worker variable R2E_ACCESS_AUD for Access JWT validation.",
    );
  }
  return aud;
}

function decodeBase64Url(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = normalized.length % 4;
  if (remainder === 1) {
    throw new HttpError(401, "access_jwt_invalid", "Malformed Access JWT.");
  }
  const padded =
    remainder === 0 ? normalized : remainder === 2 ? `${normalized}==` : `${normalized}=`;
  let decoded = "";
  try {
    decoded = atob(padded);
  } catch {
    throw new HttpError(401, "access_jwt_invalid", "Malformed Access JWT.");
  }
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return bytes;
}

function decodeJwtJson<T>(segment: string): T {
  const bytes = decodeBase64Url(segment);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(401, "access_jwt_invalid", "Malformed Access JWT payload.");
  }
  return parsed as T;
}

function parseAccessJwt(jwt: string): {
  encodedHeader: string;
  encodedPayload: string;
  encodedSignature: string;
  header: AccessJwtHeader;
  payload: AccessJwtPayload;
} {
  const parts = jwt.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new HttpError(401, "access_jwt_invalid", "Malformed Access JWT.");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtJson<AccessJwtHeader>(encodedHeader);
  const payload = decodeJwtJson<AccessJwtPayload>(encodedPayload);
  return { encodedHeader, encodedPayload, encodedSignature, header, payload };
}

function parseNumericClaim(value: unknown, claim: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new HttpError(401, "access_jwt_invalid", `Invalid Access JWT claim: ${claim}.`);
}

function claimString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function validateAccessClaims(payload: AccessJwtPayload, teamDomain: string, expectedAud: string): void {
  const expectedIssuer = `https://${teamDomain}`;
  const issuer = claimString(payload.iss);
  if (!issuer || (issuer !== expectedIssuer && issuer !== `${expectedIssuer}/`)) {
    throw new HttpError(401, "access_jwt_invalid", "Access JWT issuer does not match expected team domain.");
  }

  const aud = payload.aud;
  if (typeof aud === "string") {
    if (aud !== expectedAud) {
      throw new HttpError(401, "access_jwt_invalid", "Access JWT audience does not match expected value.");
    }
  } else if (Array.isArray(aud)) {
    const matches = aud.some((value) => value === expectedAud);
    if (!matches) {
      throw new HttpError(401, "access_jwt_invalid", "Access JWT audience does not match expected value.");
    }
  } else {
    throw new HttpError(401, "access_jwt_invalid", "Access JWT audience claim is missing or invalid.");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = parseNumericClaim(payload.exp, "exp");
  if (exp <= nowSec) {
    throw new HttpError(401, "access_jwt_invalid", "Access JWT is expired.");
  }

  if (payload.nbf !== undefined) {
    const nbf = parseNumericClaim(payload.nbf, "nbf");
    if (nbf > nowSec + 30) {
      throw new HttpError(401, "access_jwt_invalid", "Access JWT is not valid yet.");
    }
  }
}

async function fetchAccessSigningKeys(teamDomain: string): Promise<CachedAccessSigningKeys> {
  const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
  let response: Response;
  try {
    response = await fetch(certsUrl, { method: "GET" });
  } catch (error) {
    throw new HttpError(401, "access_jwt_invalid", "Failed to fetch Access signing keys.", {
      cause: String(error),
      certsUrl,
    });
  }

  if (!response.ok) {
    throw new HttpError(401, "access_jwt_invalid", "Failed to fetch Access signing keys.", {
      certsUrl,
      status: response.status,
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new HttpError(401, "access_jwt_invalid", "Access signing keys response is not valid JSON.", {
      cause: String(error),
      certsUrl,
    });
  }

  const keysRaw = (payload as { keys?: unknown })?.keys;
  if (!Array.isArray(keysRaw) || keysRaw.length === 0) {
    throw new HttpError(401, "access_jwt_invalid", "Access signing keys response is missing keys.");
  }

  const keysByKid = new Map<string, CryptoKey>();
  let fallbackKey: CryptoKey | null = null;
  for (const candidate of keysRaw) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const jwk = candidate as AccessJwk;
    if (jwk.kty !== "RSA") {
      continue;
    }
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
    } catch {
      continue;
    }
    if (!fallbackKey) {
      fallbackKey = key;
    }
    if (typeof jwk.kid === "string" && jwk.kid.length > 0) {
      keysByKid.set(jwk.kid, key);
    }
  }

  if (!fallbackKey) {
    throw new HttpError(401, "access_jwt_invalid", "No usable Access signing keys were found.");
  }

  return {
    fetchedAtMs: Date.now(),
    keysByKid,
    fallbackKey,
  };
}

async function accessSigningKeys(teamDomain: string, forceRefresh = false): Promise<CachedAccessSigningKeys> {
  const nowMs = Date.now();
  const cached = accessSigningKeyCache.get(teamDomain);
  if (!forceRefresh && cached && nowMs - cached.fetchedAtMs < ACCESS_JWKS_CACHE_TTL_MS) {
    return cached;
  }
  const fresh = await fetchAccessSigningKeys(teamDomain);
  accessSigningKeyCache.set(teamDomain, fresh);
  return fresh;
}

function keyForJwt(header: AccessJwtHeader, keys: CachedAccessSigningKeys): CryptoKey | null {
  const kid = claimString(header.kid);
  if (kid) {
    return keys.keysByKid.get(kid) ?? null;
  }
  return keys.fallbackKey;
}

async function verifyJwtSignature(
  signingInput: string,
  encodedSignature: string,
  key: CryptoKey,
): Promise<boolean> {
  const signature = decodeBase64Url(encodedSignature);
  const signatureBuffer = new Uint8Array(signature.byteLength);
  signatureBuffer.set(signature);
  return crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    signatureBuffer.buffer,
    new TextEncoder().encode(signingInput),
  );
}

async function validateAccessJwt(jwt: string, env: Env): Promise<AccessJwtPayload> {
  const teamDomain = normalizeAccessTeamDomain(env);
  const expectedAud = requiredAccessAudience(env);
  const parsed = parseAccessJwt(jwt);
  if (parsed.header.alg !== "RS256") {
    throw new HttpError(401, "access_jwt_invalid", "Access JWT must use RS256.");
  }

  const signingInput = `${parsed.encodedHeader}.${parsed.encodedPayload}`;
  let keys = await accessSigningKeys(teamDomain);
  let key = keyForJwt(parsed.header, keys);
  if (!key) {
    keys = await accessSigningKeys(teamDomain, true);
    key = keyForJwt(parsed.header, keys);
  }
  if (!key) {
    throw new HttpError(401, "access_jwt_invalid", "Access JWT key id was not found in current cert set.");
  }

  let verified = false;
  try {
    verified = await verifyJwtSignature(signingInput, parsed.encodedSignature, key);
  } catch {
    verified = false;
  }
  if (!verified) {
    const refreshed = await accessSigningKeys(teamDomain, true);
    const refreshedKey = keyForJwt(parsed.header, refreshed);
    if (!refreshedKey) {
      throw new HttpError(401, "access_jwt_invalid", "Access JWT key id was not found in current cert set.");
    }
    try {
      verified = await verifyJwtSignature(signingInput, parsed.encodedSignature, refreshedKey);
    } catch {
      verified = false;
    }
  }
  if (!verified) {
    throw new HttpError(401, "access_jwt_invalid", "Access JWT signature validation failed.");
  }

  validateAccessClaims(parsed.payload, teamDomain, expectedAud);
  return parsed.payload;
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

export async function requireApiIdentity(request: Request, env: Env): Promise<AccessIdentity> {
  const identity = extractAccessIdentity(request);
  if (!identity) {
    throw new HttpError(
      401,
      "access_required",
      "Cloudflare Access identity is required for /api routes.",
    );
  }
  if (!identity.jwt) {
    throw new HttpError(401, "access_required", "Cf-Access-Jwt-Assertion header is required for /api routes.");
  }
  const jwtPayload = await validateAccessJwt(identity.jwt, env);
  const jwtEmail = claimString(jwtPayload.email);
  const jwtUserId = claimString(jwtPayload.sub);
  return {
    email: jwtEmail,
    userId: jwtUserId,
    jwt: identity.jwt,
  };
}

export async function requireAccessOrAdminSignature(
  request: Request,
  env: Env,
  rawBody: string,
): Promise<{ mode: "access" | "hmac"; actor: string }> {
  const identity = extractAccessIdentity(request);
  if (identity) {
    const verifiedIdentity = await requireApiIdentity(request, env);
    const actor = verifiedIdentity.email ?? verifiedIdentity.userId ?? "access-user";
    return { mode: "access", actor };
  }

  const kid = await verifyAdminSignature(request, env, rawBody);
  return { mode: "hmac", actor: `hmac:${kid}` };
}
