import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createTestEnv, signedHeaders } from "./helpers/memory";

describe("auth middleware", () => {
  it("rejects /api/list without Access identity", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const request = new Request("https://files.example.com/api/list?prefix=");
    const response = await app.fetch(request, env);
    const payload = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(401);
    expect(payload.error.code).toBe("access_required");
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
