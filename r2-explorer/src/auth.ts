import { HttpError } from "./http";
import type { AuthIdentity, Env } from "./types";

const DEFAULT_IDP_CLOCK_SKEW_SEC = 60;
const DEFAULT_IDP_JWKS_CACHE_TTL_SEC = 300;
const DEFAULT_WEB_SESSION_COOKIE_NAME = "r2e_session";

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
  return [fallback];
}

export function requiredReadScopes(env: Env): string[] {
  return requiredScopes(env.R2E_IDP_REQUIRED_SCOPES_READ, env.R2E_IDP_REQUIRED_SCOPES, "r2.read");
}

export function requiredWriteScopes(env: Env): string[] {
  return requiredScopes(env.R2E_IDP_REQUIRED_SCOPES_WRITE, env.R2E_IDP_REQUIRED_SCOPES, "r2.write");
}

export function requiredShareManageScopes(env: Env): string[] {
  return requiredScopes(
    env.R2E_IDP_REQUIRED_SCOPES_SHARE_MANAGE,
    env.R2E_IDP_REQUIRED_SCOPES,
    "r2.share.manage",
  );
}

function extractBearerJwt(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) {
    return null;
  }
  const match = /^\s*Bearer\s+(.+?)\s*$/iu.exec(authorizationHeader);
  if (!match) {
    return "";
  }
  return match[1] ?? "";
}

export function sessionCookieName(env: Env | undefined): string {
  const configured = env?.R2E_WEB_COOKIE_NAME?.trim();
  if (!configured) {
    return DEFAULT_WEB_SESSION_COOKIE_NAME;
  }
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(configured)) {
    throw new HttpError(500, "oauth_web_config_invalid", "R2E_WEB_COOKIE_NAME contains unsupported characters.");
  }
  return configured;
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

function extractSessionJwt(request: Request, env: Env | undefined): string | null {
  const cookieName = sessionCookieName(env);
  const cookies = parseCookies(request.headers.get("cookie"));
  const encodedToken = cookies.get(cookieName);
  if (encodedToken === undefined) {
    return null;
  }
  try {
    return decodeURIComponent(encodedToken).trim();
  } catch {
    return "";
  }
}

export function extractAuthIdentity(request: Request, env?: Env): AuthIdentity | null {
  const jwt = extractBearerJwt(request.headers.get("authorization"));
  if (jwt !== null) {
    return {
      email: null,
      userId: null,
      jwt,
      source: "bearer_header",
    };
  }

  const sessionJwt = extractSessionJwt(request, env);
  if (sessionJwt === null) {
    return null;
  }

  return {
    email: null,
    userId: null,
    jwt: sessionJwt,
    source: "session_cookie",
  };
}

function normalizeIdpIssuer(env: Env): string {
  const raw = env.R2E_IDP_ISSUER?.trim() ?? "";
  if (raw.length === 0) {
    throw new HttpError(500, "idp_config_invalid", "Missing required Worker variable R2E_IDP_ISSUER.");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HttpError(500, "idp_config_invalid", "R2E_IDP_ISSUER must be an absolute https URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new HttpError(500, "idp_config_invalid", "R2E_IDP_ISSUER must use https.");
  }
  if (parsed.search || parsed.hash) {
    throw new HttpError(500, "idp_config_invalid", "R2E_IDP_ISSUER must not include query or hash.");
  }

  return parsed.toString().replace(/\/+$/u, "");
}

function requiredIdpAudiences(env: Env): string[] {
  const raw = env.R2E_IDP_AUDIENCE?.trim() ?? "";
  if (raw.length === 0) {
    throw new HttpError(500, "idp_config_invalid", "Missing required Worker variable R2E_IDP_AUDIENCE.");
  }
  const audiences = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (audiences.length === 0) {
    throw new HttpError(500, "idp_config_invalid", "R2E_IDP_AUDIENCE must contain at least one value.");
  }
  return audiences;
}

function normalizeIdpJwksUrl(env: Env, issuer: string): string {
  const raw = env.R2E_IDP_JWKS_URL?.trim();
  const candidate = raw && raw.length > 0 ? raw : `${issuer}/jwks`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new HttpError(500, "idp_config_invalid", "R2E_IDP_JWKS_URL must be an absolute https URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new HttpError(500, "idp_config_invalid", "R2E_IDP_JWKS_URL must use https.");
  }
  return parsed.toString();
}

function idpClockSkewSeconds(env: Env): number {
  return parseNonNegativeInt(env.R2E_IDP_CLOCK_SKEW_SEC, DEFAULT_IDP_CLOCK_SKEW_SEC);
}

function idpJwksCacheTtlSeconds(env: Env): number {
  return parsePositiveInt(env.R2E_IDP_JWKS_CACHE_TTL_SEC, DEFAULT_IDP_JWKS_CACHE_TTL_SEC);
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

function validateIdpClaims(payload: AuthJwtPayload, issuer: string, expectedAudiences: string[], clockSkewSec: number): void {
  const tokenIssuer = normalizeIssuerClaim(claimString(payload.iss));
  if (!tokenIssuer || tokenIssuer !== issuer) {
    throw new HttpError(401, "token_claim_mismatch", "Bearer JWT issuer does not match expected issuer.");
  }

  const aud = payload.aud;
  if (typeof aud === "string") {
    if (!expectedAudiences.includes(aud)) {
      throw new HttpError(401, "token_claim_mismatch", "Bearer JWT audience does not match expected value.");
    }
  } else if (Array.isArray(aud)) {
    const audValues = aud.filter((value): value is string => typeof value === "string");
    const matches = expectedAudiences.some((expected) => audValues.includes(expected));
    if (!matches) {
      throw new HttpError(401, "token_claim_mismatch", "Bearer JWT audience does not match expected value.");
    }
  } else {
    throw new HttpError(401, "token_claim_mismatch", "Bearer JWT audience claim is missing or invalid.");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = parseNumericClaim(payload.exp, "exp");
  if (exp + clockSkewSec <= nowSec) {
    throw new HttpError(401, "token_invalid", "Bearer JWT is expired.");
  }

  if (payload.nbf !== undefined) {
    const nbf = parseNumericClaim(payload.nbf, "nbf");
    if (nbf > nowSec + clockSkewSec) {
      throw new HttpError(401, "token_invalid", "Bearer JWT is not valid yet.");
    }
  }
}

async function fetchIdpSigningKeys(jwksUrl: string): Promise<CachedAuthSigningKeys> {
  let response: Response;
  try {
    response = await fetch(jwksUrl, { method: "GET" });
  } catch (error) {
    throw new HttpError(401, "token_invalid_signature", "Failed to fetch OAuth signing keys.", {
      cause: String(error),
      jwksUrl,
    });
  }

  if (!response.ok) {
    throw new HttpError(401, "token_invalid_signature", "Failed to fetch OAuth signing keys.", {
      jwksUrl,
      status: response.status,
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new HttpError(401, "token_invalid_signature", "OAuth signing keys response is not valid JSON.", {
      cause: String(error),
      jwksUrl,
    });
  }

  const keysRaw = (payload as { keys?: unknown })?.keys;
  if (!Array.isArray(keysRaw) || keysRaw.length === 0) {
    throw new HttpError(401, "token_invalid_signature", "OAuth signing keys response is missing keys.");
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
    throw new HttpError(401, "token_invalid_signature", "No usable OAuth signing keys were found.");
  }

  return {
    fetchedAtMs: Date.now(),
    keysByKidAndAlg,
    fallbackByAlg,
  };
}

async function idpSigningKeys(
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
  const fresh = await fetchIdpSigningKeys(jwksUrl);
  authSigningKeyCache.set(cacheKey, fresh);
  return fresh;
}

function parseSupportedJwtAlg(raw: unknown): SupportedJwtAlg {
  if (raw === "RS256" || raw === "EdDSA") {
    return raw;
  }
  throw new HttpError(401, "token_invalid_signature", "Bearer JWT uses unsupported signing algorithm.");
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

async function validateIdpJwt(jwt: string, env: Env): Promise<AuthJwtPayload> {
  const issuer = normalizeIdpIssuer(env);
  const expectedAudiences = requiredIdpAudiences(env);
  const jwksUrl = normalizeIdpJwksUrl(env, issuer);
  const clockSkewSec = idpClockSkewSeconds(env);
  const cacheTtlSec = idpJwksCacheTtlSeconds(env);
  const cacheKey = `${issuer}|${jwksUrl}`;

  const parsed = parseAuthJwt(jwt);
  const jwtAlg = parseSupportedJwtAlg(parsed.header.alg);

  const signingInput = `${parsed.encodedHeader}.${parsed.encodedPayload}`;
  let keys = await idpSigningKeys(cacheKey, jwksUrl, cacheTtlSec);
  let key = keyForJwt(parsed.header, keys, jwtAlg);
  if (!key) {
    keys = await idpSigningKeys(cacheKey, jwksUrl, cacheTtlSec, true);
    key = keyForJwt(parsed.header, keys, jwtAlg);
  }
  if (!key) {
    throw new HttpError(
      401,
      "token_invalid_signature",
      `Bearer JWT key id was not found in current JWKS set for alg ${jwtAlg}.`,
    );
  }

  let verified = false;
  try {
    verified = await verifyJwtSignature(signingInput, parsed.encodedSignature, key, jwtAlg);
  } catch {
    verified = false;
  }
  if (!verified) {
    const refreshed = await idpSigningKeys(cacheKey, jwksUrl, cacheTtlSec, true);
    const refreshedKey = keyForJwt(parsed.header, refreshed, jwtAlg);
    if (!refreshedKey) {
      throw new HttpError(
        401,
        "token_invalid_signature",
        `Bearer JWT key id was not found in current JWKS set for alg ${jwtAlg}.`,
      );
    }
    try {
      verified = await verifyJwtSignature(signingInput, parsed.encodedSignature, refreshedKey, jwtAlg);
    } catch {
      verified = false;
    }
  }
  if (!verified) {
    throw new HttpError(401, "token_invalid_signature", "Bearer JWT signature validation failed.");
  }

  validateIdpClaims(parsed.payload, issuer, expectedAudiences, clockSkewSec);
  return parsed.payload;
}

function requireScopes(payload: AuthJwtPayload, requiredScopes: string[]): void {
  if (requiredScopes.length === 0) {
    return;
  }
  const tokenScopeSet = tokenScopes(payload);
  const missing = requiredScopes.filter((scope) => !tokenScopeSet.has(scope));
  if (missing.length > 0) {
    throw new HttpError(403, "insufficient_scope", "Bearer token is missing required scopes.", {
      missing,
    });
  }
}

export async function requireApiIdentity(
  request: Request,
  env: Env,
  requiredScopes: string[] = [],
): Promise<AuthIdentity> {
  const identity = extractAuthIdentity(request, env);
  if (!identity) {
    throw new HttpError(401, "token_missing", "OAuth bearer token or session cookie is required for protected API routes.");
  }
  if (!identity.jwt) {
    if (identity.source === "bearer_header") {
      throw new HttpError(401, "token_invalid", "Authorization header must use Bearer authentication.");
    }
    throw new HttpError(401, "token_invalid", "Session cookie does not contain a valid OAuth access token.");
  }

  const jwtPayload = await validateIdpJwt(identity.jwt, env);
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
      "OAuth JWT is missing usable principal claims (email or sub).",
    );
  }
  return {
    email: jwtEmail,
    userId: jwtUserId,
    jwt: identity.jwt,
    source: identity.source,
  };
}
