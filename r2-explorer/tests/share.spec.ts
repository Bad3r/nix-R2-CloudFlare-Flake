import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createTestEnv, signedHeaders } from "./helpers/memory";

describe("share lifecycle", () => {
  it("creates share, serves one download, then enforces maxDownloads", async () => {
    const { env, bucket, kid, secret } = await createTestEnv();
    await bucket.put("docs/file.txt", "hello");
    const app = createApp();

    const rawBody = JSON.stringify({
      bucket: "files",
      key: "docs/file.txt",
      ttl: "24h",
      maxDownloads: 1,
    });
    const createUrl = "https://files.example.com/api/v2/share/create";
    const createTemplate = new Request(createUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rawBody,
    });
    const headers = signedHeaders(createTemplate, kid, secret, rawBody);
    const createResponse = await app.fetch(
      new Request(createUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
        },
        body: rawBody,
      }),
      env,
    );
    expect(createResponse.status).toBe(200);
    const createPayload = (await createResponse.json()) as { tokenId: string; url: string };
    expect(createPayload.tokenId).toBeTruthy();

    const firstDownload = await app.fetch(new Request(createPayload.url), env);
    expect(firstDownload.status).toBe(200);
    expect(await firstDownload.text()).toBe("hello");

    const secondDownload = await app.fetch(new Request(createPayload.url), env);
    const secondPayload = (await secondDownload.json()) as { error: { code: string } };
    expect(secondDownload.status).toBe(410);
    expect(secondPayload.error.code).toBe("share_expired");
  });

  it("revokes share token", async () => {
    const { env, bucket, kid, secret } = await createTestEnv();
    await bucket.put("docs/revocable.txt", "revocable");
    const app = createApp();

    const createBody = JSON.stringify({
      bucket: "files",
      key: "docs/revocable.txt",
      ttl: "24h",
    });
    const createUrl = "https://files.example.com/api/v2/share/create";
    const createHeaders = signedHeaders(
      new Request(createUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: createBody,
      }),
      kid,
      secret,
      createBody,
    );
    const createResponse = await app.fetch(
      new Request(createUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...createHeaders,
        },
        body: createBody,
      }),
      env,
    );
    const createPayload = (await createResponse.json()) as { tokenId: string };
    expect(createPayload.tokenId).toBeTruthy();

    const revokeBody = JSON.stringify({ tokenId: createPayload.tokenId });
    const revokeUrl = "https://files.example.com/api/v2/share/revoke";
    const revokeHeaders = signedHeaders(
      new Request(revokeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: revokeBody,
      }),
      kid,
      secret,
      revokeBody,
    );
    const revokeResponse = await app.fetch(
      new Request(revokeUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...revokeHeaders,
        },
        body: revokeBody,
      }),
      env,
    );
    expect(revokeResponse.status).toBe(200);

    const download = await app.fetch(
      new Request(`https://files.example.com/share/${createPayload.tokenId}`),
      env,
    );
    const payload = (await download.json()) as { error: { code: string } };
    expect(download.status).toBe(410);
    expect(payload.error.code).toBe("share_expired");
  });

  it("serves share downloads from a non-default bucket", async () => {
    const { env, photosBucket, kid, secret } = await createTestEnv();
    await photosBucket.put("images/cat.jpg", "meow");
    const app = createApp();

    const createBody = JSON.stringify({
      bucket: "photos",
      key: "images/cat.jpg",
      ttl: "1h",
    });
    const createUrl = "https://files.example.com/api/v2/share/create";
    const createHeaders = signedHeaders(
      new Request(createUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: createBody,
      }),
      kid,
      secret,
      createBody,
    );
    const createResponse = await app.fetch(
      new Request(createUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...createHeaders,
        },
        body: createBody,
      }),
      env,
    );
    expect(createResponse.status).toBe(200);
    const createPayload = (await createResponse.json()) as { tokenId: string; url: string };
    expect(createPayload.tokenId).toBeTruthy();

    const download = await app.fetch(new Request(createPayload.url), env);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("meow");
  });

  it("rejects unknown bucket alias on share create", async () => {
    const { env, kid, secret } = await createTestEnv();
    const app = createApp();

    const createBody = JSON.stringify({
      bucket: "unknown",
      key: "docs/missing.txt",
      ttl: "1h",
    });
    const createUrl = "https://files.example.com/api/v2/share/create";
    const createHeaders = signedHeaders(
      new Request(createUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: createBody,
      }),
      kid,
      secret,
      createBody,
    );
    const createResponse = await app.fetch(
      new Request(createUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...createHeaders,
        },
        body: createBody,
      }),
      env,
    );
    expect(createResponse.status).toBe(400);
    const payload = (await createResponse.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("bucket_unknown");
  });

  it("rejects missing bucket binding on share create", async () => {
    const { env, kid, secret } = await createTestEnv();
    env.R2E_BUCKET_MAP = JSON.stringify({
      files: "FILES_BUCKET",
      logs: "LOGS_BUCKET",
    });
    const app = createApp();

    const createBody = JSON.stringify({
      bucket: "logs",
      key: "logs/boot.txt",
      ttl: "1h",
    });
    const createUrl = "https://files.example.com/api/v2/share/create";
    const createHeaders = signedHeaders(
      new Request(createUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: createBody,
      }),
      kid,
      secret,
      createBody,
    );
    const createResponse = await app.fetch(
      new Request(createUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...createHeaders,
        },
        body: createBody,
      }),
      env,
    );
    expect(createResponse.status).toBe(500);
    const payload = (await createResponse.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("bucket_binding_missing");
  });
});
