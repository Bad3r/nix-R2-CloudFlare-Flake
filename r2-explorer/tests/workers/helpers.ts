/*
 * Access JWT + JWKS fixtures for the workerd test pool.
 *
 * node:crypto is unavailable inside workerd, so unlike tests/helpers/memory.ts
 * these helpers sign RS256 tokens with WebCrypto. The issuer/audience literals
 * must match the miniflare bindings in vitest.workers.config.ts.
 */
import { afterEach, beforeEach } from "vitest";
import { resetAuthSigningKeyCache } from "../../src/auth";

export const WORKERS_AUTH_TEAM_DOMAIN = "repo.cloudflareaccess.com";
export const WORKERS_AUTH_ISSUER = `https://${WORKERS_AUTH_TEAM_DOMAIN}`;
export const WORKERS_AUTH_AUD = "4e6af42fbb5a5c49daa17742abca157c30bac4f734855b695f02e1c4ae849769";

const ACCESS_TEST_KID = "workers-access-kid";

type RsaFixture = {
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
};

let fixturePromise: Promise<RsaFixture> | null = null;

function rsaFixture(): Promise<RsaFixture> {
  fixturePromise ??= (async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const exported = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown>;
    return {
      privateKey: pair.privateKey,
      publicJwk: {
        ...exported,
        kid: ACCESS_TEST_KID,
        use: "sig",
        alg: "RS256",
      },
    };
  })();
  return fixturePromise;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeJsonSegment(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

export type WorkersAccessJwtOptions = {
  email?: string;
  sub?: string;
  scope?: string;
};

export async function createAccessJwt(options: WorkersAccessJwtOptions = {}): Promise<string> {
  const { privateKey } = await rsaFixture();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: ACCESS_TEST_KID };
  const payload = {
    iss: WORKERS_AUTH_ISSUER,
    aud: WORKERS_AUTH_AUD,
    exp: now + 300,
    iat: now,
    nbf: now - 5,
    scope: options.scope ?? "r2.read r2.write r2.share.manage",
    email: options.email ?? "engineer@example.com",
    sub: options.sub ?? "access-user-id",
  };
  const signingInput = `${encodeJsonSegment(header)}.${encodeJsonSegment(payload)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function accessHeaders(options: WorkersAccessJwtOptions = {}): Promise<Record<string, string>> {
  return { "cf-access-jwt-assertion": await createAccessJwt(options) };
}

export async function jsonMutationHeaders(options: WorkersAccessJwtOptions = {}): Promise<Record<string, string>> {
  return {
    ...(await accessHeaders(options)),
    "content-type": "application/json",
    origin: "https://files.example.com",
    "x-r2e-csrf": "1",
  };
}

/**
 * Vitest lifecycle helper: serves the test JWKS for the Access certs URL via
 * a global fetch stub before each test and restores fetch + clears the
 * worker's signing key cache after each test.
 */
export function useWorkersAccessJwks(): void {
  let originalFetch: typeof globalThis.fetch | null = null;

  beforeEach(() => {
    const previousFetch = globalThis.fetch;
    originalFetch = previousFetch;
    const jwksUrl = `${WORKERS_AUTH_ISSUER}/cdn-cgi/access/certs`;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === jwksUrl) {
        const { publicJwk } = await rsaFixture();
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return previousFetch(input, init);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
      originalFetch = null;
    }
    resetAuthSigningKeyCache();
  });
}
