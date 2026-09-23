import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { resetAuthSigningKeyCache } from "../src/auth";
import {
  accessHeaders,
  accessJwksKeys,
  alternateAccessPublicJwk,
  AUTH_TEST_ISSUER,
  createAccessJwt,
  createTestEnv,
} from "./helpers/memory";

const JWKS_URL = `${AUTH_TEST_ISSUER}/cdn-cgi/access/certs`;

/** Install a fetch mock counting JWKS requests, with a caller-controlled response. */
function installCountingJwksMock(respond: () => Response): { fetchCount: () => number; restore: () => void } {
  const originalFetch = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === JWKS_URL) {
      count += 1;
      return respond();
    }
    return originalFetch(input, init);
  };
  return {
    fetchCount: () => count,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function jwksResponse(keys: JsonWebKey[]): Response {
  return new Response(JSON.stringify({ keys }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function listRequest(env: Awaited<ReturnType<typeof createTestEnv>>["env"], headers: HeadersInit) {
  const app = createApp();
  return app.fetch(new Request("https://files.example.com/api/v2/list?prefix=", { headers }), env);
}

describe("JWKS signing key cache", () => {
  afterEach(() => {
    resetAuthSigningKeyCache();
  });

  it("does not refetch when a request reuses an already-cached, fresh kid with a bad signature", async () => {
    const { env } = await createTestEnv();
    const mock = installCountingJwksMock(() => jwksResponse(accessJwksKeys()));
    try {
      const warm = await listRequest(env, accessHeaders());
      expect(warm.status).toBe(200);
      expect(mock.fetchCount()).toBe(1);

      for (let i = 0; i < 4; i += 1) {
        const response = await listRequest(
          env,
          accessHeaders("ops@example.com", { signWithAlternateKey: true }),
        );
        expect(response.status).toBe(401);
      }
      // The kid was known and fresh; a bad signature must fail closed without
      // spending another live JWKS fetch.
      expect(mock.fetchCount()).toBe(1);
    } finally {
      mock.restore();
    }
  });

  it("rate-limits refetches forced by spamming invented kids", async () => {
    const { env } = await createTestEnv();
    const mock = installCountingJwksMock(() => jwksResponse(accessJwksKeys()));
    try {
      const warm = await listRequest(env, accessHeaders());
      expect(warm.status).toBe(200);
      expect(mock.fetchCount()).toBe(1);

      for (let i = 0; i < 3; i += 1) {
        const response = await listRequest(env, accessHeaders("ops@example.com", { headerKid: `invented-${i}` }));
        expect(response.status).toBe(401);
      }
      // All three invented kids arrive within the same rate-limit window as
      // the warm-up fetch, so none of them should force a new one.
      expect(mock.fetchCount()).toBe(1);
    } finally {
      mock.restore();
    }
  });

  it("shares one in-flight fetch across concurrent cold-cache requests", async () => {
    const { env } = await createTestEnv();
    const mock = installCountingJwksMock(() => jwksResponse(accessJwksKeys()));
    try {
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => listRequest(env, accessHeaders())),
      );
      for (const response of responses) {
        expect(response.status).toBe(200);
      }
      expect(mock.fetchCount()).toBe(1);
    } finally {
      mock.restore();
    }
  });

  it("caches a JWKS fetch failure briefly instead of retrying on every request", async () => {
    const { env } = await createTestEnv();
    const mock = installCountingJwksMock(() => new Response("certs backend down", { status: 503 }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const first = await listRequest(env, accessHeaders());
      expect(first.status).toBe(401);
      expect(mock.fetchCount()).toBe(1);

      const second = await listRequest(env, accessHeaders());
      expect(second.status).toBe(401);
      // Still within the negative-cache window: no second live attempt.
      expect(mock.fetchCount()).toBe(1);
    } finally {
      mock.restore();
      errorSpy.mockRestore();
    }
  });

  it("picks up a genuine key rotation once the forced-refresh interval elapses", async () => {
    const { env } = await createTestEnv();
    let keys = accessJwksKeys();
    const mock = installCountingJwksMock(() => jwksResponse(keys));
    try {
      const warm = await listRequest(env, accessHeaders());
      expect(warm.status).toBe(200);
      expect(mock.fetchCount()).toBe(1);

      // An invented kid immediately after warm-up is rate-limited (proven by
      // the dedicated spam test above); jump past the forced-refresh
      // interval so the *next* unknown kid is allowed to force a live fetch.
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now() + 31_000);
        const rotatedKid = "rotated-kid";
        keys = [...accessJwksKeys(), alternateAccessPublicJwk(rotatedKid)];
        const rotatedJwt = createAccessJwt({
          email: "ops@example.com",
          sub: "access-user-id",
          headerKid: rotatedKid,
          signWithAlternateKey: true,
        });
        const response = await listRequest(env, { "cf-access-jwt-assertion": rotatedJwt });
        expect(response.status).toBe(200);
      } finally {
        vi.useRealTimers();
      }
      expect(mock.fetchCount()).toBe(2);
    } finally {
      mock.restore();
    }
  });

  it("picks up a rotation for a kid-less token, whose key is chosen by algorithm", async () => {
    const { env } = await createTestEnv();
    let keys = accessJwksKeys();
    const mock = installCountingJwksMock(() => jwksResponse(keys));
    try {
      const warm = await listRequest(env, accessHeaders());
      expect(warm.status).toBe(200);
      expect(mock.fetchCount()).toBe(1);

      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now() + 31_000);
        // The rotated key comes first, so it becomes the per-algorithm fallback.
        keys = [alternateAccessPublicJwk("rotated-kid"), ...accessJwksKeys()];
        const kidlessJwt = createAccessJwt({
          email: "ops@example.com",
          sub: "access-user-id",
          headerKid: "",
          signWithAlternateKey: true,
        });
        const response = await listRequest(env, { "cf-access-jwt-assertion": kidlessJwt });
        expect(response.status).toBe(200);
        expect(mock.fetchCount()).toBe(2);

        // The same token again is served from the refreshed cache.
        const again = await listRequest(env, { "cf-access-jwt-assertion": kidlessJwt });
        expect(again.status).toBe(200);
        expect(mock.fetchCount()).toBe(2);

        // A kid-less token signed by a key that is not the fallback stays 401 and,
        // inside the forced-refresh interval, cannot buy another JWKS fetch.
        const staleJwt = createAccessJwt({ email: "ops@example.com", sub: "access-user-id", headerKid: "" });
        const rejected = await listRequest(env, { "cf-access-jwt-assertion": staleJwt });
        expect(rejected.status).toBe(401);
        expect(mock.fetchCount()).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    } finally {
      mock.restore();
    }
  });
});
