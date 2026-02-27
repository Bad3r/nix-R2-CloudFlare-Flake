import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import {
  accessHeaders,
  accessHeadersWithoutJwt,
  accessSessionCookie,
  createAccessJwt,
  createTestEnv,
  useAccessJwksFetchMock,
} from "./helpers/memory";

describe("auth middleware", () => {
  useAccessJwksFetchMock();

  it("rejects /api/v2/list without bearer token", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const request = new Request("https://files.example.com/api/v2/list?prefix=");
    const response = await app.fetch(request, env);
    const payload = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(401);
    expect(payload.error.code).toBe("token_missing");
  });

  it("rejects /api/v2/list when Authorization header does not use Bearer", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const request = new Request("https://files.example.com/api/v2/list?prefix=", {
      headers: accessHeadersWithoutJwt("ops@example.com"),
    });
    const response = await app.fetch(request, env);
    const payload = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(401);
    expect(payload.error.code).toBe("token_invalid");
  });

  it("rejects invalid OAuth JWT signature", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const request = new Request("https://files.example.com/api/v2/list?prefix=", {
      headers: accessHeaders("ops@example.com", {
        signWithAlternateKey: true,
      }),
    });
    const response = await app.fetch(request, env);
    const payload = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(401);
    expect(payload.error.code).toBe("token_invalid_signature");
  });

  it("rejects OAuth JWT with wrong audience", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const request = new Request("https://files.example.com/api/v2/list?prefix=", {
      headers: accessHeaders("ops@example.com", {
        aud: "unexpected-audience",
      }),
    });
    const response = await app.fetch(request, env);
    const payload = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(401);
    expect(payload.error.code).toBe("token_claim_mismatch");
  });

  it("rejects expired OAuth JWT", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const request = new Request("https://files.example.com/api/v2/list?prefix=", {
      headers: accessHeaders("ops@example.com", { expiresInSec: -60 }),
    });
    const response = await app.fetch(request, env);
    const payload = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(401);
    expect(payload.error.code).toBe("token_invalid");
  });

  it("rejects OAuth JWT with nbf far in the future", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const request = new Request("https://files.example.com/api/v2/list?prefix=", {
      headers: accessHeaders("ops@example.com", { nbfOffsetSec: 120 }),
    });
    const response = await app.fetch(request, env);
    const payload = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(401);
    expect(payload.error.code).toBe("token_invalid");
  });

  it("fails closed when OAuth verifier config is missing", async () => {
    const { env } = await createTestEnv();
    env.R2E_IDP_AUDIENCE = "";
    const app = createApp();
    const request = new Request("https://files.example.com/api/v2/list?prefix=", {
      headers: accessHeaders("ops@example.com"),
    });
    const response = await app.fetch(request, env);
    const payload = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(500);
    expect(payload.error.code).toBe("idp_config_invalid");
  });

  it("accepts valid OAuth JWT on /api routes", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/list?prefix=", {
        headers: accessHeaders("ops@example.com"),
      }),
      env,
    );
    expect(response.status).toBe(200);
  });

  it("accepts valid OAuth JWT from the browser session cookie", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/list?prefix=", {
        headers: {
          cookie: accessSessionCookie(env, "ops@example.com"),
        },
      }),
      env,
    );
    expect(response.status).toBe(200);
  });

  it("starts OAuth web login with state + PKCE transaction cookie", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/auth/login?return_to=%2Fworkspace%2Fdemo"),
      env,
    );
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toBeTruthy();
    const authorizeUrl = new URL(location ?? "https://invalid.example.com");
    expect(authorizeUrl.origin).toBe("https://auth.unsigned.sh");
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("r2-explorer-web");
    expect(authorizeUrl.searchParams.get("state")).toBeTruthy();
    expect(authorizeUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("r2e_oauth_tx=");
    expect(setCookie).toContain("HttpOnly");
  });

  it("exchanges OAuth callback code and sets browser session cookie", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const loginResponse = await app.fetch(new Request("https://files.example.com/api/v2/auth/login"), env);
    expect(loginResponse.status).toBe(302);
    const authorizeUrl = new URL(loginResponse.headers.get("location") ?? "https://invalid.example.com");
    const state = authorizeUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    const transactionCookie = (loginResponse.headers.get("set-cookie") ?? "").split(";")[0];
    expect(transactionCookie).toContain("r2e_oauth_tx=");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === env.R2E_WEB_OAUTH_TOKEN_URL) {
        return new Response(
          JSON.stringify({
            access_token: createAccessJwt({
              email: "ops@example.com",
              scope: "r2.read r2.write r2.share.manage",
            }),
            token_type: "Bearer",
            expires_in: 1800,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }
      return originalFetch(input, init);
    };

    try {
      const callbackResponse = await app.fetch(
        new Request(`https://files.example.com/api/v2/auth/callback?code=auth-code&state=${encodeURIComponent(state ?? "")}`, {
          headers: {
            cookie: transactionCookie,
          },
        }),
        env,
      );
      expect(callbackResponse.status).toBe(302);
      expect(callbackResponse.headers.get("location")).toBe("/");
      const setCookie = callbackResponse.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("r2e_session=");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("enforces required read scope on /api/v2/list", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const jwt = createAccessJwt({ email: "ops@example.com", scope: "r2.write" });
    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/list?prefix=", {
        headers: {
          authorization: `Bearer ${jwt}`,
        },
      }),
      env,
    );
    const payload = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(403);
    expect(payload.error.code).toBe("insufficient_scope");
  });

  it("enforces Origin/CSRF on cookie-authenticated mutating routes", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/delete-me.txt", "delete me");
    const app = createApp();
    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/object/delete", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://files.example.com",
          cookie: accessSessionCookie(env, "ops@example.com"),
        },
        body: JSON.stringify({
          key: "docs/delete-me.txt",
        }),
      }),
      env,
    );
    const payload = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(403);
    expect(payload.error.code).toBe("csrf_required");
  });

  it("allows bearer-auth mutating routes without Origin/CSRF", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/delete-me-too.txt", "delete me");
    const app = createApp();
    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/object/delete", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders("ops@example.com", { scope: "r2.write" }),
        },
        body: JSON.stringify({
          key: "docs/delete-me-too.txt",
        }),
      }),
      env,
    );
    expect(response.status).toBe(200);
  });

  it("allows share create with bearer token only", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/report.txt", "report");
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/share/create", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders("ops@example.com", { scope: "r2.share.manage" }),
        },
        body: JSON.stringify({
          bucket: "files",
          key: "docs/report.txt",
          ttl: "24h",
          maxDownloads: 1,
        }),
      }),
      env,
    );
    expect(response.status).toBe(200);
  });
});
