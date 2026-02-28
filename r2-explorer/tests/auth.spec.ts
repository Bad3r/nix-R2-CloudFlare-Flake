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

  it("rejects /api/v2/list without Cloudflare Access JWT", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const request = new Request("https://files.example.com/api/v2/list?prefix=");
    const response = await app.fetch(request, env);
    const payload = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(401);
    expect(payload.error.code).toBe("access_required");
  });

  it("rejects /api/v2/list when cf-access-jwt-assertion is empty", async () => {
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

  it("rejects invalid Access JWT signature", async () => {
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

  it("rejects Access JWT with wrong audience", async () => {
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

  it("rejects expired Access JWT", async () => {
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

  it("rejects Access JWT with nbf far in the future", async () => {
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

  it("fails closed when Access verifier config is missing", async () => {
    const { env } = await createTestEnv();
    env.R2E_ACCESS_AUD = "";
    const app = createApp();
    const request = new Request("https://files.example.com/api/v2/list?prefix=", {
      headers: accessHeaders("ops@example.com"),
    });
    const response = await app.fetch(request, env);
    const payload = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(500);
    expect(payload.error.code).toBe("access_config_invalid");
  });

  it("accepts valid Access JWT on /api routes", async () => {
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

  it("accepts valid EdDSA Access JWT on /api routes", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/list?prefix=", {
        headers: accessHeaders("ops@example.com", {
          alg: "EdDSA",
        }),
      }),
      env,
    );
    expect(response.status).toBe(200);
  });

  it("accepts valid Access JWT from CF_Authorization cookie", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/list?prefix=", {
        headers: {
          cookie: accessSessionCookie("ops@example.com"),
        },
      }),
      env,
    );
    expect(response.status).toBe(200);
  });

  it("enforces required read scope on /api/v2/list", async () => {
    const { env } = await createTestEnv();
    env.R2E_ACCESS_REQUIRED_SCOPES_READ = "r2.read";
    const app = createApp();
    const jwt = createAccessJwt({ email: "ops@example.com", scope: "r2.write" });
    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/list?prefix=", {
        headers: {
          "cf-access-jwt-assertion": jwt,
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
          cookie: accessSessionCookie("ops@example.com"),
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
