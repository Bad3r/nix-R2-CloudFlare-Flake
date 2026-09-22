import { envInt, envNonNegativeInt } from "./config";
import { HttpError } from "./http";
import type { AuthIdentity, Env } from "./types";

const DEFAULT_ACCESS_CLOCK_SKEW_SEC = 60;
const DEFAULT_ACCESS_JWKS_CACHE_TTL_SEC = 300;

type AuthJwtHeader = {
  alg?: unknown;
  kid?: unknown;
};

type AuthJwtPayload = {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  sub?: unknown;
  email?: unknown;
  common_name?: unknown;
  service_token_id?: unknown;
  scope?: unknown;
  scp?: unknown;
};

type AuthJwk = JsonWebKey & {
  kid?: string;
};

type SupportedJwtAlg = "RS256" | "EdDSA";

type CachedAuthSigningKeys = {
  fetchedAtMs: number;
  keysByKidAndAlg: Map<string, CryptoKey>;
  fallbackByAlg: Map<SupportedJwtAlg, CryptoKey>;
};

// A JWKS fetch failure is cached for a few seconds: long enough that an
// Access outage does not turn into a live fetch on every single request,
// short enough that recovery is visible almost immediately once the endpoint
// is back.
const NEGATIVE_CACHE_TTL_MS = 5_000;

// An unknown kid forces at most one refetch per interval, independent of
// R2E_ACCESS_JWKS_CACHE_TTL_SEC. 30s is short enough that a genuine Access
// key rotation authenticates again well within a client's own retry window,
// and long enough that spamming invented kids cannot turn into a live JWKS
// fetch on every request.
const MIN_FORCED_REFRESH_INTERVAL_MS = 30_000;

type SigningKeysCacheEntry = {
  /** Most recently resolved key set, if any fetch for this cache key has ever succeeded. */
  resolved?: CachedAuthSigningKeys;
  /** Shared by concurrent callers that find a cold or expired cache, so they issue one fetch, not one each. */
  inFlight?: Promise<CachedAuthSigningKeys>;
  /** Completion time of the most recent fetch attempt (success or failure); gates both the negative cache and the forced-refresh rate limit. */
  lastAttemptAtMs?: number;
  /** Error from the most recent attempt, if it failed. */
  lastError?: unknown;
};

const authSigningKeyCache = new Map<string, SigningKeysCacheEntry>();

/** Clear the JWKS signing key cache. Exported for test teardown. */
export function resetAuthSigningKeyCache(): void {
  authSigningKeyCache.clear();
}

function signingKeysCacheEntry(cacheKey: string): SigningKeysCacheEntry {
  let entry = authSigningKeyCache.get(cacheKey);
  if (!entry) {
    entry = {};
    authSigningKeyCache.set(cacheKey, entry);
  }
  return entry;
}

function parseScopeList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[\s,]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function requiredScopes(
  specific: string | undefined,
  generic: string | undefined,
  fallback: string,
): string[] {
  const fromSpecific = parseScopeList(specific);
  if (fromSpecific.length > 0) {
    return fromSpecific;
  }
  const fromGeneric = parseScopeList(generic);
  if (fromGeneric.length > 0) {
    return fromGeneric;
  }
  if (!fallback.trim()) {
    return [];
  }
  return [fallback];
}

export function requiredReadScopes(env: Env): string[] {
  return requiredScopes(env.R2E_ACCESS_REQUIRED_SCOPES_READ, env.R2E_ACCESS_REQUIRED_SCOPES, "");
}

export function requiredWriteScopes(env: Env): string[] {
  return requiredScopes(env.R2E_ACCESS_REQUIRED_SCOPES_WRITE, env.R2E_ACCESS_REQUIRED_SCOPES, "");
}

export function requiredShareManageScopes(env: Env): string[] {
  return requiredScopes(
    env.R2E_ACCESS_REQUIRED_SCOPES_SHARE_MANAGE,
    env.R2E_ACCESS_REQUIRED_SCOPES,
    "",
  );
}

function extractAccessHeaderJwt(accessHeader: string | null): string | null {
  if (accessHeader === null) {
    return null;
  }
  return accessHeader.trim();
}

function parseCookies(cookieHeader: string | null): Map<string, string> {
  const parsed = new Map<string, string>();
  if (!cookieHeader) {
    return parsed;
  }
  for (const rawPart of cookieHeader.split(";")) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (!name) {
      continue;
    }
    parsed.set(name, part.slice(separator + 1));
  }
  return parsed;
}

function extractAccessCookieJwt(request: Request): string | null {
  const cookies = parseCookies(request.headers.get("cookie"));
  let encodedToken = cookies.get("CF_Authorization");
  if (encodedToken === undefined) {
    for (const [name, value] of cookies.entries()) {
      if (name.startsWith("CF_Authorization_")) {
        encodedToken = value;
        break;
      }
    }
  }
  if (encodedToken === undefined) {
    return null;
  }
  try {
    return decodeURIComponent(encodedToken).trim();
  } catch {
    return "";
  }
}

export function extractAuthIdentity(request: Request): AuthIdentity | null {
  const jwt = extractAccessHeaderJwt(request.headers.get("cf-access-jwt-assertion"));
  if (jwt !== null) {
    return {
      email: null,
      userId: null,
      jwt,
      source: "access_header",
    };
  }

  const cookieJwt = extractAccessCookieJwt(request);
  if (cookieJwt === null) {
    return null;
  }

  return {
    email: null,
    userId: null,
    jwt: cookieJwt,
    source: "access_cookie",
  };
}

function normalizeAccessTeamDomain(env: Env): string {
  const raw = env.R2E_ACCESS_TEAM_DOMAIN?.trim() ?? "";
  if (raw.length === 0) {
    throw new HttpError(500, "access_config_invalid", "Missing required Worker variable R2E_ACCESS_TEAM_DOMAIN.");
  }

  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//iu.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new HttpError(
      500,
      "access_config_invalid",
      "R2E_ACCESS_TEAM_DOMAIN must be a hostname or absolute https URL.",
    );
  }
  if (parsed.protocol !== "https:") {
    throw new HttpError(500, "access_config_invalid", "R2E_ACCESS_TEAM_DOMAIN must use https.");
  }
  if (parsed.search || parsed.hash) {
    throw new HttpError(500, "access_config_invalid", "R2E_ACCESS_TEAM_DOMAIN must not include query or hash.");
  }
  if (parsed.pathname && parsed.pathname !== "/") {
    throw new HttpError(
      500,
      "access_config_invalid",
      "R2E_ACCESS_TEAM_DOMAIN must not include a path. Use R2E_ACCESS_JWKS_URL to override cert endpoint.",
    );
  }

  return `${parsed.protocol}//${parsed.host}`;
}

function requiredAccessAudiences(env: Env): string[] {
  const raw = env.R2E_ACCESS_AUD?.trim() ?? "";
  if (raw.length === 0) {
    throw new HttpError(500, "access_config_invalid", "Missing required Worker variable R2E_ACCESS_AUD.");
  }
  const audiences = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (audiences.length === 0) {
    throw new HttpError(500, "access_config_invalid", "R2E_ACCESS_AUD must contain at least one value.");
  }
  return audiences;
}

function normalizeAccessJwksUrl(env: Env, teamDomain: string): string {
  const raw = env.R2E_ACCESS_JWKS_URL?.trim();
  const candidate = raw && raw.length > 0 ? raw : `${teamDomain}/cdn-cgi/access/certs`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new HttpError(500, "access_config_invalid", "R2E_ACCESS_JWKS_URL must be an absolute https URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new HttpError(500, "access_config_invalid", "R2E_ACCESS_JWKS_URL must use https.");
  }
  return parsed.toString();
}

function accessClockSkewSeconds(env: Env): number {
  return envNonNegativeInt(
    "R2E_ACCESS_CLOCK_SKEW_SEC",
    env.R2E_ACCESS_CLOCK_SKEW_SEC,
    DEFAULT_ACCESS_CLOCK_SKEW_SEC,
    "access_config_invalid",
  );
}

function accessJwksCacheTtlSeconds(env: Env): number {
  return envInt(
    "R2E_ACCESS_JWKS_CACHE_TTL_SEC",
    env.R2E_ACCESS_JWKS_CACHE_TTL_SEC,
    DEFAULT_ACCESS_JWKS_CACHE_TTL_SEC,
    "access_config_invalid",
  );
}

function decodeBase64Url(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = normalized.length % 4;
  if (remainder === 1) {
    throw new HttpError(401, "token_invalid", "Malformed bearer JWT.");
  }
  const padded =
    remainder === 0 ? normalized : remainder === 2 ? `${normalized}==` : `${normalized}=`;
  let decoded = "";
  try {
    decoded = atob(padded);
  } catch {
    throw new HttpError(401, "token_invalid", "Malformed bearer JWT.");
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
    throw new HttpError(401, "token_invalid", "Malformed bearer JWT payload.");
  }
  return parsed as T;
}

function parseAuthJwt(jwt: string): {
  encodedHeader: string;
  encodedPayload: string;
  encodedSignature: string;
  header: AuthJwtHeader;
  payload: AuthJwtPayload;
} {
  const parts = jwt.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new HttpError(401, "token_invalid", "Malformed bearer JWT.");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtJson<AuthJwtHeader>(encodedHeader);
  const payload = decodeJwtJson<AuthJwtPayload>(encodedPayload);
  return { encodedHeader, encodedPayload, encodedSignature, header, payload };
}

function parseNumericClaim(value: unknown, claim: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new HttpError(401, "token_invalid", `Invalid bearer JWT claim: ${claim}.`);
}

function claimString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeIssuerClaim(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return value.replace(/\/+$/u, "");
}

function tokenScopes(payload: AuthJwtPayload): Set<string> {
  const scopes = new Set<string>();

  if (typeof payload.scope === "string") {
    for (const item of payload.scope.split(/\s+/u)) {
      const trimmed = item.trim();
      if (trimmed.length > 0) {
        scopes.add(trimmed);
      }
    }
  }

  if (typeof payload.scp === "string") {
    const trimmed = payload.scp.trim();
    if (trimmed.length > 0) {
      scopes.add(trimmed);
    }
  }

  if (Array.isArray(payload.scp)) {
    for (const candidate of payload.scp) {
      if (typeof candidate === "string") {
        const trimmed = candidate.trim();
        if (trimmed.length > 0) {
          scopes.add(trimmed);
        }
      }
    }
  }

  return scopes;
}

function validateAccessClaims(payload: AuthJwtPayload, issuer: string, expectedAudiences: string[], clockSkewSec: number): void {
  const tokenIssuer = normalizeIssuerClaim(claimString(payload.iss));
  if (!tokenIssuer || tokenIssuer !== issuer) {
    throw new HttpError(401, "token_claim_mismatch", "Access JWT issuer does not match expected team domain.");
  }

  const aud = payload.aud;
  if (typeof aud === "string") {
    if (!expectedAudiences.includes(aud)) {
      throw new HttpError(401, "token_claim_mismatch", "Access JWT audience does not match expected value.");
    }
  } else if (Array.isArray(aud)) {
    const audValues = aud.filter((value): value is string => typeof value === "string");
    const matches = expectedAudiences.some((expected) => audValues.includes(expected));
    if (!matches) {
      throw new HttpError(401, "token_claim_mismatch", "Access JWT audience does not match expected value.");
    }
  } else {
    throw new HttpError(401, "token_claim_mismatch", "Access JWT audience claim is missing or invalid.");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = parseNumericClaim(payload.exp, "exp");
  if (exp + clockSkewSec <= nowSec) {
    throw new HttpError(401, "token_invalid", "Access JWT is expired.");
  }

  if (payload.nbf !== undefined) {
    const nbf = parseNumericClaim(payload.nbf, "nbf");
    if (nbf > nowSec + clockSkewSec) {
      throw new HttpError(401, "token_invalid", "Access JWT is not valid yet.");
    }
  }
}

async function fetchAccessSigningKeys(jwksUrl: string): Promise<CachedAuthSigningKeys> {
  // JWKS fetch failures log the endpoint and cause for operators; the
  // client-facing error stays free of deployment config such as the JWKS URL.
  let response: Response;
  try {
    response = await fetch(jwksUrl, { method: "GET" });
  } catch (error) {
    console.error(`Failed to fetch Access signing keys from ${jwksUrl}:`, error);
    throw new HttpError(401, "token_invalid_signature", "Failed to fetch Cloudflare Access signing keys.");
  }

  if (!response.ok) {
    console.error(`Access signing keys fetch from ${jwksUrl} returned status ${response.status}.`);
    throw new HttpError(401, "token_invalid_signature", "Failed to fetch Cloudflare Access signing keys.");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    console.error(`Access certs response from ${jwksUrl} is not valid JSON:`, error);
    throw new HttpError(401, "token_invalid_signature", "Access certs response is not valid JSON.");
  }

  const keysRaw = (payload as { keys?: unknown })?.keys;
  if (!Array.isArray(keysRaw) || keysRaw.length === 0) {
    throw new HttpError(401, "token_invalid_signature", "Access certs response is missing keys.");
  }

  const keysByKidAndAlg = new Map<string, CryptoKey>();
  const fallbackByAlg = new Map<SupportedJwtAlg, CryptoKey>();
  for (const candidate of keysRaw) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const jwk = candidate as AuthJwk;

    const importConfigs: Array<{
      alg: SupportedJwtAlg;
      importAlgorithm: EcKeyImportParams | RsaHashedImportParams | AlgorithmIdentifier;
    }> = [];

    if (jwk.kty === "RSA" && (!jwk.alg || jwk.alg === "RS256")) {
      importConfigs.push({
        alg: "RS256",
        importAlgorithm: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      });
    }

    if (jwk.kty === "OKP" && jwk.crv === "Ed25519" && (!jwk.alg || jwk.alg === "EdDSA")) {
      importConfigs.push({
        alg: "EdDSA",
        importAlgorithm: "Ed25519",
      });
    }

    for (const config of importConfigs) {
      let key: CryptoKey;
      try {
        key = await crypto.subtle.importKey("jwk", jwk, config.importAlgorithm, false, ["verify"]);
      } catch {
        continue;
      }

      if (!fallbackByAlg.has(config.alg)) {
        fallbackByAlg.set(config.alg, key);
      }

      if (typeof jwk.kid === "string" && jwk.kid.length > 0) {
        keysByKidAndAlg.set(`${config.alg}:${jwk.kid}`, key);
      }
    }
  }

  if (fallbackByAlg.size === 0) {
    throw new HttpError(401, "token_invalid_signature", "No usable Access signing keys were found.");
  }

  return {
    fetchedAtMs: Date.now(),
    keysByKidAndAlg,
    fallbackByAlg,
  };
}

/**
 * Resolve the cached JWKS key set, fetching only when required:
 * - A fresh resolved entry (age < ttlSec) is returned as-is unless forced.
 * - Concurrent callers that find no in-flight fetch and no usable cache share
 *   one fetch: the in-flight promise is stored before any await, so callers
 *   racing in the same microtask turn all observe it.
 * - A forced refresh (unknown kid) is itself rate-limited to at most one
 *   attempt per MIN_FORCED_REFRESH_INTERVAL_MS, independent of ttlSec, so
 *   inventing kids cannot force a fetch on every request.
 * - A recent failure is cached for NEGATIVE_CACHE_TTL_MS and re-thrown
 *   directly, so an outage does not become a fetch per request.
 */
async function accessSigningKeys(
  cacheKey: string,
  jwksUrl: string,
  ttlSec: number,
  forceRefresh = false,
): Promise<CachedAuthSigningKeys> {
  const entry = signingKeysCacheEntry(cacheKey);
  const nowMs = Date.now();

  if (!forceRefresh && entry.resolved && nowMs - entry.resolved.fetchedAtMs < ttlSec * 1000) {
    return entry.resolved;
  }

  if (entry.inFlight) {
    return entry.inFlight;
  }

  if (
    entry.lastError !== undefined &&
    entry.lastAttemptAtMs !== undefined &&
    nowMs - entry.lastAttemptAtMs < NEGATIVE_CACHE_TTL_MS
  ) {
    throw entry.lastError;
  }

  if (
    forceRefresh &&
    entry.lastAttemptAtMs !== undefined &&
    nowMs - entry.lastAttemptAtMs < MIN_FORCED_REFRESH_INTERVAL_MS
  ) {
    if (entry.resolved) {
      return entry.resolved;
    }
    if (entry.lastError !== undefined) {
      throw entry.lastError;
    }
  }

  const attempt = (async () => {
    try {
      const fresh = await fetchAccessSigningKeys(jwksUrl);
      entry.resolved = fresh;
      entry.lastError = undefined;
      return fresh;
    } catch (error) {
      entry.lastError = error;
      throw error;
    } finally {
      entry.lastAttemptAtMs = Date.now();
      entry.inFlight = undefined;
    }
  })();
  entry.inFlight = attempt;
  return attempt;
}

function parseSupportedJwtAlg(raw: unknown): SupportedJwtAlg {
  if (raw === "RS256" || raw === "EdDSA") {
    return raw;
  }
  throw new HttpError(401, "token_invalid_signature", "Access JWT uses unsupported signing algorithm.");
}

function keyForJwt(header: AuthJwtHeader, keys: CachedAuthSigningKeys, alg: SupportedJwtAlg): CryptoKey | null {
  const kid = claimString(header.kid);
  if (kid) {
    return keys.keysByKidAndAlg.get(`${alg}:${kid}`) ?? null;
  }
  return keys.fallbackByAlg.get(alg) ?? null;
}

async function verifyJwtSignature(
  signingInput: string,
  encodedSignature: string,
  key: CryptoKey,
  alg: SupportedJwtAlg,
): Promise<boolean> {
  const signature = decodeBase64Url(encodedSignature);
  const signatureBuffer = new Uint8Array(signature.byteLength);
  signatureBuffer.set(signature);
  const verifyAlgorithm: AlgorithmIdentifier | RsaPssParams | EcdsaParams =
    alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : "Ed25519";
  return crypto.subtle.verify(
    verifyAlgorithm,
    key,
    signatureBuffer,
    new TextEncoder().encode(signingInput),
  );
}

async function validateAccessJwt(jwt: string, env: Env): Promise<AuthJwtPayload> {
  const issuer = normalizeAccessTeamDomain(env);
  const expectedAudiences = requiredAccessAudiences(env);
  const jwksUrl = normalizeAccessJwksUrl(env, issuer);
  const clockSkewSec = accessClockSkewSeconds(env);
  const cacheTtlSec = accessJwksCacheTtlSeconds(env);
  const cacheKey = `${issuer}|${jwksUrl}`;

  const parsed = parseAuthJwt(jwt);
  const jwtAlg = parseSupportedJwtAlg(parsed.header.alg);

  const signingInput = `${parsed.encodedHeader}.${parsed.encodedPayload}`;
  let keys = await accessSigningKeys(cacheKey, jwksUrl, cacheTtlSec);
  let key = keyForJwt(parsed.header, keys, jwtAlg);
  if (!key) {
    // Unknown kid: force a refetch (rate-limited inside accessSigningKeys) so
    // a genuine Access key rotation is picked up without waiting out
    // cacheTtlSec, while spamming invented kids cannot force a fetch per
    // request.
    keys = await accessSigningKeys(cacheKey, jwksUrl, cacheTtlSec, true);
    key = keyForJwt(parsed.header, keys, jwtAlg);
  }
  if (!key) {
    throw new HttpError(
      401,
      "token_invalid_signature",
      `Access JWT key id was not found in current JWKS set for alg ${jwtAlg}.`,
    );
  }

  let verified = false;
  try {
    verified = await verifyJwtSignature(signingInput, parsed.encodedSignature, key, jwtAlg);
  } catch {
    verified = false;
  }
  if (!verified && !claimString(parsed.header.kid)) {
    // A kid-less token selects its key by algorithm, so a rotation never shows
    // up as an unknown kid: retry once against a (rate-limited) refetch.
    const refreshedKey = keyForJwt(parsed.header, await accessSigningKeys(cacheKey, jwksUrl, cacheTtlSec, true), jwtAlg);
    if (refreshedKey && refreshedKey !== key) {
      try {
        verified = await verifyJwtSignature(signingInput, parsed.encodedSignature, refreshedKey, jwtAlg);
      } catch {
        verified = false;
      }
    }
  }
  if (!verified) {
    // A failure against a known kid is never a reason to refetch: the same key
    // would come back, and a forged token would buy a JWKS fetch per request.
    throw new HttpError(401, "token_invalid_signature", "Access JWT signature validation failed.");
  }

  validateAccessClaims(parsed.payload, issuer, expectedAudiences, clockSkewSec);
  return parsed.payload;
}

function requireScopes(payload: AuthJwtPayload, requiredScopes: string[]): void {
  if (requiredScopes.length === 0) {
    return;
  }
  const tokenScopeSet = tokenScopes(payload);
  const missing = requiredScopes.filter((scope) => !tokenScopeSet.has(scope));
  if (missing.length > 0) {
    throw new HttpError(403, "insufficient_scope", "Access JWT is missing required scopes.", {
      missing,
    });
  }
}

export async function requireApiIdentity(
  request: Request,
  env: Env,
  requiredScopes: string[] = [],
): Promise<AuthIdentity> {
  const identity = extractAuthIdentity(request);
  if (!identity) {
    throw new HttpError(401, "access_required", "Cloudflare Access authentication is required for protected API routes.");
  }
  if (!identity.jwt) {
    if (identity.source === "access_header") {
      throw new HttpError(401, "token_invalid", "cf-access-jwt-assertion header is present but empty.");
    }
    throw new HttpError(401, "token_invalid", "CF_Authorization cookie does not contain a valid Access JWT.");
  }

  const jwtPayload = await validateAccessJwt(identity.jwt, env);
  requireScopes(jwtPayload, requiredScopes);

  const jwtEmail = claimString(jwtPayload.email);
  const jwtUserId =
    claimString(jwtPayload.sub) ??
    claimString(jwtPayload.common_name) ??
    claimString(jwtPayload.service_token_id);
  if (!jwtEmail && !jwtUserId) {
    throw new HttpError(
      401,
      "token_invalid",
      "Access JWT is missing usable principal claims (email, sub, common_name, or service_token_id).",
    );
  }
  return {
    email: jwtEmail,
    userId: jwtUserId,
    jwt: identity.jwt,
    source: identity.source,
  };
}
