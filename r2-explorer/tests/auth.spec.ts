import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import {
  accessHeaders,
  accessHeadersWithoutJwt,
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
