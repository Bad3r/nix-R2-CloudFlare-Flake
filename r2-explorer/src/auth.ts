import { HttpError } from "./http";
import type { ApiIdentity, Env } from "./types";

const OAUTH_JWKS_CACHE_TTL_MS = 5 * 60 * 1000;

type JwtHeader = {
  alg?: unknown;
  kid?: unknown;
};

type JwtPayload = {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  sub?: unknown;
  email?: unknown;
  client_id?: unknown;
  scope?: unknown;
  scp?: unknown;
};

type CachedSigningKeys = {
  fetchedAtMs: number;
  keysByKid: Map<string, JsonWebKey>;
  fallbackKey: JsonWebKey | null;
};

type VerifyConfig = {
  name: "RSASSA-PKCS1-v1_5" | "RSA-PSS";
  hash: "SHA-256" | "SHA-384" | "SHA-512";
  saltLength?: number;
};

const jwksCache = new Map<string, CachedSigningKeys>();

/** Clear the OAuth JWKS signing key cache. Exported for test teardown. */
export function resetAuthJwksCache(): void {
  jwksCache.clear();
}

function claimString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function claimNumeric(value: unknown, claim: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new HttpError(401, "oauth_token_invalid", `Invalid OAuth token claim: ${claim}.`);
}

function requiredAuthIssuer(env: Env): string {
  const raw = env.R2E_AUTH_ISSUER?.trim() ?? "";
  if (raw.length === 0) {
    throw new HttpError(
      500,
      "oauth_config_invalid",
      "Missing required Worker variable R2E_AUTH_ISSUER for OAuth token validation.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HttpError(500, "oauth_config_invalid", "R2E_AUTH_ISSUER must be a valid URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new HttpError(500, "oauth_config_invalid", "R2E_AUTH_ISSUER must use http or https.");
  }
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/u, "");
}

function requiredAuthAudience(env: Env): string {
  const aud = env.R2E_AUTH_AUDIENCE?.trim() ?? "";
  if (aud.length === 0) {
    throw new HttpError(
      500,
      "oauth_config_invalid",
      "Missing required Worker variable R2E_AUTH_AUDIENCE for OAuth token validation.",
    );
  }
  return aud;
}

function authJwksUrl(env: Env, issuer: string): string {
  const configured = env.R2E_AUTH_JWKS_URL?.trim();
  const raw = configured && configured.length > 0 ? configured : `${issuer}/jwks`;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HttpError(500, "oauth_config_invalid", "R2E_AUTH_JWKS_URL must be a valid URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new HttpError(500, "oauth_config_invalid", "R2E_AUTH_JWKS_URL must use http or https.");
  }
  parsed.hash = "";
  return parsed.toString();
}

export function extractBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/iu);
  if (!match) {
    return null;
  }
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

function decodeBase64Url(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = normalized.length % 4;
  if (remainder === 1) {
    throw new HttpError(401, "oauth_token_invalid", "Malformed OAuth token.");
  }
  const padded = remainder === 0 ? normalized : `${normalized}${"=".repeat(4 - remainder)}`;

  let decoded = "";
  try {
    decoded = atob(padded);
  } catch {
    throw new HttpError(401, "oauth_token_invalid", "Malformed OAuth token.");
  }

  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return bytes;
}

function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned.buffer;
}

function decodeJwtJson<T>(segment: string): T {
  const bytes = decodeBase64Url(segment);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(401, "oauth_token_invalid", "Malformed OAuth token payload.");
  }
  return parsed as T;
}

function parseJwt(token: string): {
  encodedHeader: string;
  encodedPayload: string;
  encodedSignature: string;
  header: JwtHeader;
  payload: JwtPayload;
} {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new HttpError(401, "oauth_token_invalid", "Malformed OAuth token.");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtJson<JwtHeader>(encodedHeader);
  const payload = decodeJwtJson<JwtPayload>(encodedPayload);
  return {
    encodedHeader,
    encodedPayload,
    encodedSignature,
    header,
    payload,
  };
}

function verifyConfigForAlg(rawAlg: unknown): VerifyConfig {
  if (typeof rawAlg !== "string" || rawAlg.trim().length === 0) {
    throw new HttpError(401, "oauth_token_invalid", "OAuth token algorithm claim is missing.");
  }
  switch (rawAlg) {
    case "RS256":
      return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
    case "RS384":
      return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" };
    case "RS512":
      return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" };
    case "PS256":
      return { name: "RSA-PSS", hash: "SHA-256", saltLength: 32 };
    case "PS384":
      return { name: "RSA-PSS", hash: "SHA-384", saltLength: 48 };
    case "PS512":
      return { name: "RSA-PSS", hash: "SHA-512", saltLength: 64 };
    default:
      throw new HttpError(401, "oauth_token_invalid", `Unsupported OAuth token algorithm: ${rawAlg}.`);
  }
}

async function fetchSigningKeys(jwksUrl: string): Promise<CachedSigningKeys> {
  let response: Response;
  try {
    response = await fetch(jwksUrl, { method: "GET" });
  } catch (error) {
    throw new HttpError(401, "oauth_token_invalid", "Failed to fetch OAuth signing keys.", {
      cause: String(error),
      jwksUrl,
    });
  }

  if (!response.ok) {
    throw new HttpError(401, "oauth_token_invalid", "Failed to fetch OAuth signing keys.", {
      jwksUrl,
      status: response.status,
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new HttpError(401, "oauth_token_invalid", "OAuth signing keys response is not valid JSON.", {
      cause: String(error),
      jwksUrl,
    });
  }

  const keysRaw = (payload as { keys?: unknown })?.keys;
  if (!Array.isArray(keysRaw) || keysRaw.length === 0) {
    throw new HttpError(401, "oauth_token_invalid", "OAuth signing keys response is missing keys.");
  }

  const keysByKid = new Map<string, JsonWebKey>();
  let fallbackKey: JsonWebKey | null = null;
  for (const candidate of keysRaw) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const jwk = candidate as JsonWebKey & { kid?: unknown };
    if (jwk.kty !== "RSA") {
      continue;
    }
    if (!fallbackKey) {
      fallbackKey = jwk;
    }
    if (typeof jwk.kid === "string" && jwk.kid.length > 0) {
      keysByKid.set(jwk.kid, jwk);
    }
  }

  if (!fallbackKey) {
    throw new HttpError(401, "oauth_token_invalid", "No usable OAuth signing keys were found.");
  }

  return {
    fetchedAtMs: Date.now(),
    keysByKid,
    fallbackKey,
  };
}

async function signingKeys(jwksUrl: string, forceRefresh = false): Promise<CachedSigningKeys> {
  const nowMs = Date.now();
  const cached = jwksCache.get(jwksUrl);
  if (!forceRefresh && cached && nowMs - cached.fetchedAtMs < OAUTH_JWKS_CACHE_TTL_MS) {
    return cached;
  }
  const fresh = await fetchSigningKeys(jwksUrl);
  jwksCache.set(jwksUrl, fresh);
  return fresh;
}

function keyForJwt(header: JwtHeader, keys: CachedSigningKeys): JsonWebKey | null {
  const kid = claimString(header.kid);
  if (kid) {
    return keys.keysByKid.get(kid) ?? null;
  }
  return keys.fallbackKey;
}

async function verifyJwtSignature(
  signingInput: string,
  encodedSignature: string,
  jwk: JsonWebKey,
  config: VerifyConfig,
): Promise<boolean> {
  if (jwk.kty !== "RSA") {
    return false;
  }

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: config.name, hash: config.hash },
      false,
      ["verify"],
    );
  } catch {
    return false;
  }

  const signature = decodeBase64Url(encodedSignature);
  const algorithm =
    config.name === "RSA-PSS"
      ? {
          name: "RSA-PSS" as const,
          saltLength: config.saltLength ?? 32,
        }
      : ({
          name: "RSASSA-PKCS1-v1_5" as const,
        });
  const signingInputBytes = new TextEncoder().encode(signingInput);
  return crypto.subtle.verify(
    algorithm,
    key,
    toOwnedArrayBuffer(signature),
    toOwnedArrayBuffer(signingInputBytes),
  );
}

function validateJwtClaims(payload: JwtPayload, expectedIssuer: string, expectedAudience: string): void {
  const issuer = claimString(payload.iss);
  if (!issuer) {
    throw new HttpError(401, "oauth_token_invalid", "OAuth token issuer claim is missing.");
  }
  const normalizedIssuer = issuer.replace(/\/+$/u, "");
  if (normalizedIssuer !== expectedIssuer) {
    throw new HttpError(401, "oauth_token_invalid", "OAuth token issuer does not match expected value.");
  }

  const audience = payload.aud;
  if (typeof audience === "string") {
    if (audience !== expectedAudience) {
      throw new HttpError(401, "oauth_token_invalid", "OAuth token audience does not match expected value.");
    }
  } else if (Array.isArray(audience)) {
    const matches = audience.some((item) => item === expectedAudience);
    if (!matches) {
      throw new HttpError(401, "oauth_token_invalid", "OAuth token audience does not match expected value.");
    }
  } else {
    throw new HttpError(401, "oauth_token_invalid", "OAuth token audience claim is missing or invalid.");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = claimNumeric(payload.exp, "exp");
  if (exp <= nowSec) {
    throw new HttpError(401, "oauth_token_invalid", "OAuth token is expired.");
  }

  if (payload.nbf !== undefined) {
    const nbf = claimNumeric(payload.nbf, "nbf");
    if (nbf > nowSec + 30) {
      throw new HttpError(401, "oauth_token_invalid", "OAuth token is not valid yet.");
    }
  }
}

function scopeSet(payload: JwtPayload): Set<string> {
  const scopes = new Set<string>();
  if (typeof payload.scope === "string") {
    for (const token of payload.scope.split(/\s+/u).filter((value) => value.length > 0)) {
      scopes.add(token);
    }
  }

  if (typeof payload.scp === "string") {
    for (const token of payload.scp.split(/\s+/u).filter((value) => value.length > 0)) {
      scopes.add(token);
    }
  } else if (Array.isArray(payload.scp)) {
    for (const value of payload.scp) {
      if (typeof value === "string" && value.length > 0) {
        scopes.add(value);
      }
    }
  }
  return scopes;
}

async function validateOauthToken(token: string, env: Env): Promise<JwtPayload> {
  const expectedIssuer = requiredAuthIssuer(env);
  const expectedAudience = requiredAuthAudience(env);
  const jwksUrl = authJwksUrl(env, expectedIssuer);
  const parsed = parseJwt(token);
  const verifyConfig = verifyConfigForAlg(parsed.header.alg);
  const signingInput = `${parsed.encodedHeader}.${parsed.encodedPayload}`;

  let keys = await signingKeys(jwksUrl);
  let jwk = keyForJwt(parsed.header, keys);
  if (!jwk) {
    keys = await signingKeys(jwksUrl, true);
    jwk = keyForJwt(parsed.header, keys);
  }
  if (!jwk) {
    throw new HttpError(401, "oauth_token_invalid", "OAuth token key id was not found in current JWKS set.");
  }

  let verified = false;
  try {
    verified = await verifyJwtSignature(signingInput, parsed.encodedSignature, jwk, verifyConfig);
  } catch {
    verified = false;
  }

  // Retry with fresh JWKS in case keys were rotated since last cache refresh
  if (!verified) {
    const refreshed = await signingKeys(jwksUrl, true);
    const refreshedKey = keyForJwt(parsed.header, refreshed);
    if (!refreshedKey) {
      throw new HttpError(401, "oauth_token_invalid", "OAuth token key id was not found in current JWKS set.");
    }
    try {
      verified = await verifyJwtSignature(signingInput, parsed.encodedSignature, refreshedKey, verifyConfig);
    } catch {
      verified = false;
    }
  }

  if (!verified) {
    throw new HttpError(401, "oauth_token_invalid", "OAuth token signature validation failed.");
  }

  validateJwtClaims(parsed.payload, expectedIssuer, expectedAudience);
  return parsed.payload;
}

export async function requireApiIdentity(request: Request, env: Env): Promise<ApiIdentity> {
  const token = extractBearerToken(request);
  if (!token) {
    throw new HttpError(401, "oauth_required", "Bearer token is required for /api/v2 routes.");
  }

  const payload = await validateOauthToken(token, env);
  const subject = claimString(payload.sub) ?? claimString(payload.client_id) ?? claimString(payload.email);
  if (!subject) {
    throw new HttpError(
      401,
      "oauth_token_invalid",
      "OAuth token is missing usable principal claims (sub, client_id, email).",
    );
  }

  const issuer = claimString(payload.iss);
  const audience = requiredAuthAudience(env);
  if (!issuer) {
    throw new HttpError(401, "oauth_token_invalid", "OAuth token issuer claim is missing.");
  }

  return {
    subject,
    email: claimString(payload.email),
    scopes: scopeSet(payload),
    issuer: issuer.replace(/\/+$/u, ""),
    audience,
    token,
  };
}

export function requireScope(identity: ApiIdentity, requiredScope: string): void {
  if (requiredScope.length === 0) {
    return;
  }
  if (!identity.scopes.has(requiredScope)) {
    throw new HttpError(403, "insufficient_scope", `Required OAuth scope is missing: ${requiredScope}.`, {
      requiredScope,
      grantedScopes: [...identity.scopes].sort(),
    });
  }
}
