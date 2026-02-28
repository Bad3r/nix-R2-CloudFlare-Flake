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

const authSigningKeyCache = new Map<string, CachedAuthSigningKeys>();

/** Clear the JWKS signing key cache. Exported for test teardown. */
export function resetAuthSigningKeyCache(): void {
  authSigningKeyCache.clear();
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

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
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
  return parseNonNegativeInt(env.R2E_ACCESS_CLOCK_SKEW_SEC, DEFAULT_ACCESS_CLOCK_SKEW_SEC);
}

function accessJwksCacheTtlSeconds(env: Env): number {
  return parsePositiveInt(env.R2E_ACCESS_JWKS_CACHE_TTL_SEC, DEFAULT_ACCESS_JWKS_CACHE_TTL_SEC);
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
  let response: Response;
  try {
    response = await fetch(jwksUrl, { method: "GET" });
  } catch (error) {
    throw new HttpError(401, "token_invalid_signature", "Failed to fetch Cloudflare Access signing keys.", {
      cause: String(error),
      jwksUrl,
    });
  }

  if (!response.ok) {
    throw new HttpError(401, "token_invalid_signature", "Failed to fetch Cloudflare Access signing keys.", {
      jwksUrl,
      status: response.status,
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new HttpError(401, "token_invalid_signature", "Access certs response is not valid JSON.", {
      cause: String(error),
      jwksUrl,
    });
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

async function accessSigningKeys(
  cacheKey: string,
  jwksUrl: string,
  ttlSec: number,
  forceRefresh = false,
): Promise<CachedAuthSigningKeys> {
  const nowMs = Date.now();
  const cached = authSigningKeyCache.get(cacheKey);
  if (!forceRefresh && cached && nowMs - cached.fetchedAtMs < ttlSec * 1000) {
    return cached;
  }
  const fresh = await fetchAccessSigningKeys(jwksUrl);
  authSigningKeyCache.set(cacheKey, fresh);
  return fresh;
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
  if (!verified) {
    const refreshed = await accessSigningKeys(cacheKey, jwksUrl, cacheTtlSec, true);
    const refreshedKey = keyForJwt(parsed.header, refreshed, jwtAlg);
    if (!refreshedKey) {
      throw new HttpError(
        401,
        "token_invalid_signature",
        `Access JWT key id was not found in current JWKS set for alg ${jwtAlg}.`,
      );
    }
    try {
      verified = await verifyJwtSignature(signingInput, parsed.encodedSignature, refreshedKey, jwtAlg);
    } catch {
      verified = false;
    }
  }
  if (!verified) {
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
