import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { getShareRecord } from "../src/kv";
import type { Env } from "../src/types";
import { accessHeaders, createTestEnv, useAccessJwksFetchMock } from "./helpers/memory";

async function createShareViaApi(
  app: ReturnType<typeof createApp>,
  env: Env,
  body: Record<string, unknown>,
): Promise<{ tokenId: string; url: string }> {
  const response = await app.fetch(
    new Request("https://files.example.com/api/v2/share/create", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...accessHeaders("ops@example.com", { scope: "r2.share.manage" }),
      },
      body: JSON.stringify(body),
    }),
    env,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { tokenId: string; url: string };
}

describe("share lifecycle", () => {
  useAccessJwksFetchMock();

  it("creates share, serves one download, then enforces maxDownloads", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/file.txt", "hello");
    const app = createApp();

    const rawBody = JSON.stringify({
      bucket: "files",
      key: "docs/file.txt",
      ttl: "24h",
      maxDownloads: 1,
    });
    const createUrl = "https://files.example.com/api/v2/share/create";
    const createResponse = await app.fetch(
      new Request(createUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders("ops@example.com", { scope: "r2.share.manage" }),
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
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/revocable.txt", "revocable");
    const app = createApp();

    const createBody = JSON.stringify({
      bucket: "files",
      key: "docs/revocable.txt",
      ttl: "24h",
    });
    const createUrl = "https://files.example.com/api/v2/share/create";
    const createResponse = await app.fetch(
      new Request(createUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders("ops@example.com", { scope: "r2.share.manage" }),
        },
        body: createBody,
      }),
      env,
    );
    const createPayload = (await createResponse.json()) as { tokenId: string };
    expect(createPayload.tokenId).toBeTruthy();

    const revokeBody = JSON.stringify({ tokenId: createPayload.tokenId });
    const revokeUrl = "https://files.example.com/api/v2/share/revoke";
    const revokeResponse = await app.fetch(
      new Request(revokeUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders("ops@example.com", { scope: "r2.share.manage" }),
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
    const { env, photosBucket } = await createTestEnv();
    await photosBucket.put("images/cat.jpg", "meow");
    const app = createApp();

    const createBody = JSON.stringify({
      bucket: "photos",
      key: "images/cat.jpg",
      ttl: "1h",
    });
    const createUrl = "https://files.example.com/api/v2/share/create";
    const createResponse = await app.fetch(
      new Request(createUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders("ops@example.com", { scope: "r2.share.manage" }),
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
    const { env } = await createTestEnv();
    const app = createApp();

    const createBody = JSON.stringify({
      bucket: "unknown",
      key: "docs/missing.txt",
      ttl: "1h",
    });
    const createUrl = "https://files.example.com/api/v2/share/create";
    const createResponse = await app.fetch(
      new Request(createUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders("ops@example.com", { scope: "r2.share.manage" }),
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
    const { env } = await createTestEnv();
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
    const createResponse = await app.fetch(
      new Request(createUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders("ops@example.com", { scope: "r2.share.manage" }),
        },
        body: createBody,
      }),
      env,
    );
    expect(createResponse.status).toBe(500);
    const payload = (await createResponse.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("bucket_binding_missing");
  });

  it("lists shares for an object via /api/v2/share/list", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/listed.txt", "listed");
    const app = createApp();

    const first = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/listed.txt",
      ttl: "1h",
    });
    const second = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/listed.txt",
      ttl: "2h",
      maxDownloads: 3,
    });

    const listResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/share/list?bucket=files&key=docs%2Flisted.txt", {
        headers: accessHeaders("ops@example.com", { scope: "r2.share.manage" }),
      }),
      env,
    );
    expect(listResponse.status).toBe(200);
    const listPayload = (await listResponse.json()) as {
      shares: Array<{ tokenId: string; key: string; maxDownloads: number }>;
      listComplete: boolean;
    };
    expect(listPayload.listComplete).toBe(true);
    const tokenIds = listPayload.shares.map((share) => share.tokenId).sort();
    expect(tokenIds).toEqual([first.tokenId, second.tokenId].sort());
    expect(listPayload.shares.every((share) => share.key === "docs/listed.txt")).toBe(true);
  });

  it("enforces maxDownloads atomically for concurrent downloads", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/limited.txt", "limited");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/limited.txt",
      ttl: "1h",
      maxDownloads: 1,
    });

    const [first, second] = await Promise.all([
      app.fetch(new Request(share.url), env),
      app.fetch(new Request(share.url), env),
    ]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 410]);
    const rejected = first.status === 410 ? first : second;
    expect(((await rejected.json()) as { error: { code: string } }).error.code).toBe("share_expired");
  });

  it("reflects the authoritative download count in the KV record", async () => {
    const { env, bucket, sharesKv } = await createTestEnv();
    await bucket.put("docs/counted.txt", "counted");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/counted.txt",
      ttl: "1h",
      maxDownloads: 3,
    });

    const download = await app.fetch(new Request(share.url), env);
    expect(download.status).toBe(200);

    const record = await getShareRecord(sharesKv as unknown as KVNamespace, share.tokenId);
    expect(record?.downloadCount).toBe(1);
  });

  it("hardens inline shares of script-capable types with nosniff and a sandbox CSP", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/page.html", "<script>alert(1)</script>", {
      httpMetadata: { contentType: "text/html" },
    });
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/page.html",
      ttl: "1h",
      contentDisposition: "inline",
    });

    const download = await app.fetch(new Request(share.url), env);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("inline");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });

  it("serves inline-safe share types inline without a CSP but with nosniff", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/manual.pdf", "%PDF-1.7 fake pdf", {
      httpMetadata: { contentType: "application/pdf" },
    });
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/manual.pdf",
      ttl: "1h",
      contentDisposition: "inline",
    });

    const download = await app.fetch(new Request(share.url), env);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("inline");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("content-security-policy")).toBeNull();
  });

  it("hardens attachment share responses with nosniff and a sandbox CSP", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/report.txt", "report body");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/report.txt",
      ttl: "1h",
    });

    const download = await app.fetch(new Request(share.url), env);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });

  it("serves shares in readonly mode without consuming download quota", async () => {
    const { env, bucket, sharesKv } = await createTestEnv();
    await bucket.put("docs/ro.txt", "readonly body");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/ro.txt",
      ttl: "1h",
      maxDownloads: 1,
    });

    env.R2E_READONLY = "true";
    const firstReadonly = await app.fetch(new Request(share.url), env);
    expect(firstReadonly.status).toBe(200);
    expect(await firstReadonly.text()).toBe("readonly body");
    const secondReadonly = await app.fetch(new Request(share.url), env);
    expect(secondReadonly.status).toBe(200);

    const untouched = await getShareRecord(sharesKv as unknown as KVNamespace, share.tokenId);
    expect(untouched?.downloadCount).toBe(0);

    // Back in read-write mode the single download slot is still available,
    // and only then does the cap engage.
    env.R2E_READONLY = "false";
    const counted = await app.fetch(new Request(share.url), env);
    expect(counted.status).toBe(200);
    const exhausted = await app.fetch(new Request(share.url), env);
    expect(exhausted.status).toBe(410);
    expect(((await exhausted.json()) as { error: { code: string } }).error.code).toBe("share_expired");
  });

  it("still rejects revoked shares in readonly mode", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/ro-revoked.txt", "revoked body");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/ro-revoked.txt",
      ttl: "1h",
    });

    const revokeResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/share/revoke", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders("ops@example.com", { scope: "r2.share.manage" }),
        },
        body: JSON.stringify({ tokenId: share.tokenId }),
      }),
      env,
    );
    expect(revokeResponse.status).toBe(200);

    env.R2E_READONLY = "true";
    const download = await app.fetch(new Request(share.url), env);
    expect(download.status).toBe(410);
    expect(((await download.json()) as { error: { code: string } }).error.code).toBe("share_expired");
  });
});
