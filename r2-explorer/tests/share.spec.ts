import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { accessHeaders, createTestEnv, useAccessJwksFetchMock } from "./helpers/memory";

describe("share lifecycle", () => {
  useAccessJwksFetchMock();

  it("creates share, serves one download, then enforces maxDownloads", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/file.txt", "hello");
    const app = createApp();

    const createResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/share/create", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders("engineer@example.com", { scope: "r2.share.manage" }),
        },
        body: JSON.stringify({
          bucket: "files",
          key: "docs/file.txt",
          ttl: "24h",
          maxDownloads: 1,
        }),
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
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/revocable.txt", "revocable");
    const app = createApp();

    const createResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/share/create", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders("engineer@example.com", { scope: "r2.share.manage" }),
        },
        body: JSON.stringify({
          bucket: "files",
          key: "docs/revocable.txt",
          ttl: "24h",
        }),
      }),
      env,
    );
    const createPayload = (await createResponse.json()) as { tokenId: string };
    expect(createPayload.tokenId).toBeTruthy();

    const revokeResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/share/revoke", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders("engineer@example.com", { scope: "r2.share.manage" }),
        },
        body: JSON.stringify({ tokenId: createPayload.tokenId }),
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
    const { env, photosBucket } = await createTestEnv();
    await photosBucket.put("images/cat.jpg", "meow");
    const app = createApp();

    const createResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/share/create", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders("engineer@example.com", { scope: "r2.share.manage" }),
        },
        body: JSON.stringify({
          bucket: "photos",
          key: "images/cat.jpg",
          ttl: "1h",
        }),
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
    const { env } = await createTestEnv();
    const app = createApp();

    const createResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/share/create", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders("engineer@example.com", { scope: "r2.share.manage" }),
        },
        body: JSON.stringify({
          bucket: "unknown",
          key: "docs/missing.txt",
          ttl: "1h",
        }),
      }),
      env,
    );
    expect(createResponse.status).toBe(400);
    const payload = (await createResponse.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("bucket_unknown");
  });

  it("rejects missing bucket binding on share create", async () => {
    const { env } = await createTestEnv();
    env.R2E_BUCKET_MAP = JSON.stringify({
      files: "FILES_BUCKET",
      logs: "LOGS_BUCKET",
    });
    const app = createApp();

    const createResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/share/create", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders("engineer@example.com", { scope: "r2.share.manage" }),
        },
        body: JSON.stringify({
          bucket: "logs",
          key: "logs/boot.txt",
          ttl: "1h",
        }),
      }),
      env,
    );
    expect(createResponse.status).toBe(500);
    const payload = (await createResponse.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("bucket_binding_missing");
  });
});
