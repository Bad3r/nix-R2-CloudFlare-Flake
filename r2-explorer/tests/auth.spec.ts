import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import {
  accessHeaders,
  accessHeadersWithoutJwt,
  createTestEnv,
  signedHeaders,
  useAccessJwksFetchMock,
} from "./helpers/memory";

describe("auth middleware", () => {
  useAccessJwksFetchMock();

  it("rejects /api/list without Access identity", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const request = new Request("https://files.example.com/api/list?prefix=");
    const response = await app.fetch(request, env);
    const payload = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(401);
    expect(payload.error.code).toBe("access_required");
  });

  it("rejects /api/list when Access headers are present but JWT is missing", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const request = new Request("https://files.example.com/api/list?prefix=", {
      headers: accessHeadersWithoutJwt("ops@example.com"),
    });
    const response = await app.fetch(request, env);
    const payload = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(401);
    expect(payload.error.code).toBe("access_required");
  });

  it("rejects invalid Access JWT signature", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const request = new Request("https://files.example.com/api/list?prefix=", {
      headers: accessHeaders("ops@example.com", {
        signWithAlternateKey: true,
      }),
    });
    const response = await app.fetch(request, env);
    const payload = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(401);
    expect(payload.error.code).toBe("access_jwt_invalid");
  });

  it("rejects Access JWT with wrong audience", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const request = new Request("https://files.example.com/api/list?prefix=", {
      headers: accessHeaders("ops@example.com", {
        aud: "unexpected-audience",
      }),
    });
    const response = await app.fetch(request, env);
    const payload = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(401);
    expect(payload.error.code).toBe("access_jwt_invalid");
  });

  it("rejects expired Access JWT", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const request = new Request("https://files.example.com/api/list?prefix=", {
      headers: accessHeaders("ops@example.com", { expiresInSec: -60 }),
    });
    const response = await app.fetch(request, env);
    const payload = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(401);
    expect(payload.error.code).toBe("access_jwt_invalid");
  });

  it("rejects Access JWT with nbf far in the future", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const request = new Request("https://files.example.com/api/list?prefix=", {
      headers: accessHeaders("ops@example.com", { nbfOffsetSec: 120 }),
    });
    const response = await app.fetch(request, env);
    const payload = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(401);
    expect(payload.error.code).toBe("access_jwt_invalid");
  });

  it("fails closed when Access verifier config is missing", async () => {
    const { env } = await createTestEnv();
    env.R2E_ACCESS_AUD = "";
    const app = createApp();
    const request = new Request("https://files.example.com/api/list?prefix=", {
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
      new Request("https://files.example.com/api/list?prefix=", {
        headers: accessHeaders("ops@example.com"),
      }),
      env,
    );
    expect(response.status).toBe(200);
  });

  it("accepts HMAC auth for share create and rejects nonce replay", async () => {
    const { env, bucket, kid, secret } = await createTestEnv();
    await bucket.put("docs/report.txt", "report");
    const app = createApp();

    const rawBody = JSON.stringify({
      bucket: "files",
      key: "docs/report.txt",
      ttl: "24h",
      maxDownloads: 1,
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = "fixed-replay-nonce";

    const createUrl = "https://files.example.com/api/share/create";
    const templateRequest = new Request(createUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rawBody,
    });
    const signatureHeaders = signedHeaders(templateRequest, kid, secret, rawBody, timestamp, nonce);

    const first = await app.fetch(
      new Request(createUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...signatureHeaders,
        },
        body: rawBody,
      }),
      env,
    );
    expect(first.status).toBe(200);

    const second = await app.fetch(
      new Request(createUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...signatureHeaders,
        },
        body: rawBody,
      }),
      env,
    );
    const secondPayload = (await second.json()) as { error: { code: string } };
    expect(second.status).toBe(401);
    expect(secondPayload.error.code).toBe("admin_signature_replay");
  });
});
