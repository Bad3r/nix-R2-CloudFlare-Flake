import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { resetAuthSigningKeyCache } from "../src/auth";
import {
  accessHeaders,
  AUTH_TEST_ISSUER,
  createTestEnv,
  useAccessJwksFetchMock,
} from "./helpers/memory";

describe("client-facing error scrubbing", () => {
  useAccessJwksFetchMock();

  it("returns a generic internal_error without leaking the thrown error", async () => {
    const { env } = await createTestEnv();
    env.FILES_BUCKET = {
      list: () => {
        throw new Error("secret-internal-detail");
      },
    } as unknown as R2Bucket;
    const app = createApp();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await app.fetch(
        new Request("https://files.example.com/api/v2/list?prefix=", {
          headers: accessHeaders(),
        }),
        env,
      );
      expect(response.status).toBe(500);
      const bodyText = await response.text();
      const payload = JSON.parse(bodyText) as { error: { code: string; message: string; details?: unknown } };
      expect(payload.error.code).toBe("internal_error");
      expect(payload.error.message).toBe("Unexpected worker error.");
      expect(payload.error.details).toBeUndefined();
      expect(bodyText).not.toContain("secret-internal-detail");
      // The real error is still logged for observability.
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("fails fast with access_config_invalid on malformed clock skew config", async () => {
    const { env } = await createTestEnv();
    env.R2E_ACCESS_CLOCK_SKEW_SEC = "not-a-number";
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/list?prefix=", {
        headers: accessHeaders(),
      }),
      env,
    );
    expect(response.status).toBe(500);
    const payload = (await response.json()) as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("access_config_invalid");
    expect(payload.error.message).toContain("R2E_ACCESS_CLOCK_SKEW_SEC");
  });

  it("omits bucket binding names from bucket_binding_missing errors", async () => {
    const { env } = await createTestEnv();
    env.R2E_BUCKET_MAP = JSON.stringify({
      files: "FILES_BUCKET",
      logs: "LOGS_BUCKET",
    });
    const app = createApp();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await app.fetch(
        new Request("https://files.example.com/api/v2/share/create", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...accessHeaders("ops@example.com", { scope: "r2.share.manage" }),
          },
          body: JSON.stringify({ bucket: "logs", key: "logs/boot.txt", ttl: "1h" }),
        }),
        env,
      );
      expect(response.status).toBe(500);
      const bodyText = await response.text();
      const payload = JSON.parse(bodyText) as { error: { code: string } };
      expect(payload.error.code).toBe("bucket_binding_missing");
      expect(bodyText).not.toContain("LOGS_BUCKET");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("omits the configured alias map from bucket_unknown errors", async () => {
    const { env } = await createTestEnv();
    const app = createApp();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await app.fetch(
        new Request("https://files.example.com/api/v2/share/create", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...accessHeaders("ops@example.com", { scope: "r2.share.manage" }),
          },
          body: JSON.stringify({ bucket: "nonexistent", key: "docs/x.txt", ttl: "1h" }),
        }),
        env,
      );
      expect(response.status).toBe(400);
      const bodyText = await response.text();
      const payload = JSON.parse(bodyText) as { error: { code: string; details?: { knownBuckets?: unknown } } };
      expect(payload.error.code).toBe("bucket_unknown");
      expect(payload.error.details?.knownBuckets).toBeUndefined();
      // "photos" is a configured alias in the test env and must not leak.
      expect(bodyText).not.toContain("photos");
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("JWKS failure error scrubbing", () => {
  it("omits the JWKS endpoint from token_invalid_signature errors", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const jwksUrl = `${AUTH_TEST_ISSUER}/cdn-cgi/access/certs`;

    const originalFetch = globalThis.fetch;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === jwksUrl) {
        return new Response("certs backend down", { status: 503 });
      }
      return originalFetch(input, init);
    };

    try {
      const response = await app.fetch(
        new Request("https://files.example.com/api/v2/list?prefix=", {
          headers: accessHeaders(),
        }),
        env,
      );
      expect(response.status).toBe(401);
      const bodyText = await response.text();
      const payload = JSON.parse(bodyText) as { error: { code: string; details?: unknown } };
      expect(payload.error.code).toBe("token_invalid_signature");
      expect(payload.error.details).toBeUndefined();
      expect(bodyText).not.toContain("cdn-cgi");
      expect(bodyText).not.toContain("cloudflareaccess.com");
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      errorSpy.mockRestore();
      resetAuthSigningKeyCache();
    }
  });
});
