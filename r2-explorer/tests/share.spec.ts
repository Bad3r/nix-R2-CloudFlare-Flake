import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { getShareRecord, shareRecordKey } from "../src/kv";
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

  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("returns 404 share_not_found for a malformed share token", async () => {
    const { env } = await createTestEnv();
    const app = createApp();

    // "%" is invalid percent-encoding; decodeURIComponent throws URIError,
    // which must map to the share 404, not a 500 internal_error.
    const response = await app.fetch(new Request("https://files.example.com/share/%"), env);
    const payload = (await response.json()) as { error: { code: string } };
    expect(response.status).toBe(404);
    expect(payload.error.code).toBe("share_not_found");
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

  it("does not consume a download on HEAD, so a following GET still succeeds", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/head.txt", "head body");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/head.txt",
      ttl: "1h",
      maxDownloads: 1,
    });

    const head = await app.fetch(new Request(share.url, { method: "HEAD" }), env);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe(String("head body".length));
    expect(head.headers.get("accept-ranges")).toBe("bytes");

    const get = await app.fetch(new Request(share.url), env);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("head body");
    expect(get.headers.get("accept-ranges")).toBe("bytes");
  });

  it("reports the same 410 a GET would for HEAD on an exhausted share", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/exhausted-head.txt", "one shot");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/exhausted-head.txt",
      ttl: "1h",
      maxDownloads: 1,
    });

    const first = await app.fetch(new Request(share.url), env);
    expect(first.status).toBe(200);
    await first.text();

    const head = await app.fetch(new Request(share.url, { method: "HEAD" }), env);
    expect(head.status).toBe(410);
  });

  it("reports the same 410 a GET would for HEAD on a revoked share", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/revoked-head.txt", "secret");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/revoked-head.txt",
      ttl: "1h",
    });

    await app.fetch(
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

    const head = await app.fetch(new Request(share.url, { method: "HEAD" }), env);
    expect(head.status).toBe(410);
  });

  it("cancels the unread object body when a download is refused", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/cancel-me.txt", "will be cancelled");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/cancel-me.txt",
      ttl: "1h",
      maxDownloads: 1,
    });

    const first = await app.fetch(new Request(share.url), env);
    expect(first.status).toBe(200);
    await first.text();
    expect(bucket.wasBodyCancelled("docs/cancel-me.txt")).toBe(false);

    const refused = await app.fetch(new Request(share.url), env);
    expect(refused.status).toBe(410);
    await refused.text();
    expect(bucket.wasBodyCancelled("docs/cancel-me.txt")).toBe(true);
  });

  it("does not touch the counter for HEAD requests in readonly mode", async () => {
    const { env, bucket, sharesKv } = await createTestEnv();
    await bucket.put("docs/ro-head.txt", "readonly head body");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/ro-head.txt",
      ttl: "1h",
      maxDownloads: 1,
    });

    env.R2E_READONLY = "true";
    const head1 = await app.fetch(new Request(share.url, { method: "HEAD" }), env);
    expect(head1.status).toBe(200);
    const head2 = await app.fetch(new Request(share.url, { method: "HEAD" }), env);
    expect(head2.status).toBe(200);

    const untouched = await getShareRecord(sharesKv as unknown as KVNamespace, share.tokenId);
    expect(untouched?.downloadCount).toBe(0);

    // Back in read-write mode the single download slot is still fully
    // intact, proving readonly HEAD never reached the counter.
    env.R2E_READONLY = "false";
    const real = await app.fetch(new Request(share.url), env);
    expect(real.status).toBe(200);
    const exhausted = await app.fetch(new Request(share.url), env);
    expect(exhausted.status).toBe(410);
  });

  it("does not touch the counter for a Range continuation in readonly mode", async () => {
    const { env, bucket, sharesKv } = await createTestEnv();
    await bucket.put("docs/ro-resume.txt", "0123456789");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/ro-resume.txt",
      ttl: "1h",
      maxDownloads: 1,
    });

    env.R2E_READONLY = "true";
    const resumed1 = await app.fetch(new Request(share.url, { headers: { range: "bytes=5-" } }), env);
    expect(resumed1.status).toBe(206);
    const resumed2 = await app.fetch(new Request(share.url, { headers: { range: "bytes=5-" } }), env);
    expect(resumed2.status).toBe(206);

    const untouched = await getShareRecord(sharesKv as unknown as KVNamespace, share.tokenId);
    expect(untouched?.downloadCount).toBe(0);

    env.R2E_READONLY = "false";
    const real = await app.fetch(new Request(share.url), env);
    expect(real.status).toBe(200);
    const exhausted = await app.fetch(new Request(share.url), env);
    expect(exhausted.status).toBe(410);
  });

  it("does not consume a slot for a Range continuation within the resume window, resuming an interrupted download", async () => {
    const { env, bucket, sharesKv } = await createTestEnv();
    await bucket.put("docs/resume.txt", "0123456789");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/resume.txt",
      ttl: "1h",
      maxDownloads: 1,
    });

    const started = await app.fetch(new Request(share.url), env);
    expect(started.status).toBe(200);
    await started.text();

    const resumed = await app.fetch(new Request(share.url, { headers: { range: "bytes=5-" } }), env);
    expect(resumed.status).toBe(206);
    expect(await resumed.text()).toBe("56789");
    expect(resumed.headers.get("accept-ranges")).toBe("bytes");

    const record = await getShareRecord(sharesKv as unknown as KVNamespace, share.tokenId);
    expect(record?.downloadCount).toBe(1);
  });

  it("refuses a Range continuation once it ages out of the resume window on an exhausted share", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/stale-resume.txt", "0123456789");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/stale-resume.txt",
      ttl: "1h",
      maxDownloads: 1,
    });

    const started = await app.fetch(new Request(share.url), env);
    expect(started.status).toBe(200);
    await started.text();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    const resumed = await app.fetch(new Request(share.url, { headers: { range: "bytes=5-" } }), env);
    expect(resumed.status).toBe(410);
    expect(((await resumed.json()) as { error: { code: string } }).error.code).toBe("share_expired");
  });

  it("treats a Range continuation with no prior counted start as a fresh download that consumes a slot", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/cold-resume.txt", "0123456789");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/cold-resume.txt",
      ttl: "1h",
      maxDownloads: 1,
    });

    const firstRequestIsRange = await app.fetch(
      new Request(share.url, { headers: { range: "bytes=5-" } }),
      env,
    );
    expect(firstRequestIsRange.status).toBe(206);
    await firstRequestIsRange.text();

    const second = await app.fetch(new Request(share.url), env);
    expect(second.status).toBe(410);
  });

  it("counts a Range request starting at byte 0 as a download start", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/zero-start.txt", "0123456789");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/zero-start.txt",
      ttl: "1h",
      maxDownloads: 1,
    });

    const first = await app.fetch(new Request(share.url, { headers: { range: "bytes=0-" } }), env);
    expect(first.status).toBe(206);
    await first.text();

    const second = await app.fetch(new Request(share.url), env);
    expect(second.status).toBe(410);
  });

  it("does not consume a slot for a 304 from a conditional GET", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/conditional.txt", "conditional body");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/conditional.txt",
      ttl: "1h",
      maxDownloads: 1,
    });

    const stored = await bucket.head("docs/conditional.txt");
    const conditional = await app.fetch(
      new Request(share.url, { headers: { "if-none-match": stored!.etag } }),
      env,
    );
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("accept-ranges")).toBe("bytes");

    const real = await app.fetch(new Request(share.url), env);
    expect(real.status).toBe(200);
    expect(await real.text()).toBe("conditional body");
  });

  it("does not consume a slot for a 416 from an out-of-range request", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/outofrange.txt", "short");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/outofrange.txt",
      ttl: "1h",
      maxDownloads: 1,
    });

    const outOfRange = await app.fetch(
      new Request(share.url, { headers: { range: "bytes=1000-2000" } }),
      env,
    );
    expect(outOfRange.status).toBe(416);
    expect(outOfRange.headers.get("accept-ranges")).toBe("bytes");

    const real = await app.fetch(new Request(share.url), env);
    expect(real.status).toBe(200);
    expect(await real.text()).toBe("short");
  });

  it("refuses a download once revoked even when the request observes a stale pre-revocation KV record", async () => {
    const { env, bucket, sharesKv } = await createTestEnv();
    await bucket.put("docs/stale-revoke.txt", "confidential");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/stale-revoke.txt",
      ttl: "1h",
    });

    const staleRecordJson = await sharesKv.get(shareRecordKey(share.tokenId));
    expect(staleRecordJson).toBeTruthy();

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

    // Simulate an edge whose cached KV read never saw the revoke: restore
    // the pre-revocation record directly, bypassing the /revoke route's own
    // (now correctly ordered) KV write.
    await sharesKv.put(shareRecordKey(share.tokenId), staleRecordJson as string);

    const download = await app.fetch(new Request(share.url), env);
    expect(download.status).toBe(410);
    expect(((await download.json()) as { error: { code: string } }).error.code).toBe("share_expired");
  });

  it("refuses a download in readonly mode when the request observes a stale pre-revocation KV record", async () => {
    const { env, bucket, sharesKv } = await createTestEnv();
    await bucket.put("docs/ro-stale-revoke.txt", "confidential");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/ro-stale-revoke.txt",
      ttl: "1h",
    });

    const staleRecordJson = await sharesKv.get(shareRecordKey(share.tokenId));
    expect(staleRecordJson).toBeTruthy();

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

    await sharesKv.put(shareRecordKey(share.tokenId), staleRecordJson as string);
    env.R2E_READONLY = "true";

    const download = await app.fetch(new Request(share.url), env);
    expect(download.status).toBe(410);
    expect(((await download.json()) as { error: { code: string } }).error.code).toBe("share_expired");
  });

  it("refuses an exhausted share in readonly mode", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/ro-exhausted.txt", "one shot");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/ro-exhausted.txt",
      ttl: "1h",
      maxDownloads: 1,
    });

    const first = await app.fetch(new Request(share.url), env);
    expect(first.status).toBe(200);
    await first.text();

    env.R2E_READONLY = "true";
    const readonlyAttempt = await app.fetch(new Request(share.url), env);
    expect(readonlyAttempt.status).toBe(410);
    expect(((await readonlyAttempt.json()) as { error: { code: string } }).error.code).toBe("share_expired");
  });

  it("serves a valid share in readonly mode with zero writes to KV and the counter", async () => {
    const { env, bucket, sharesKv, shareCounters } = await createTestEnv();
    await bucket.put("docs/ro-valid.txt", "still available");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/ro-valid.txt",
      ttl: "1h",
      maxDownloads: 1,
    });

    env.R2E_READONLY = "true";
    const putSpy = vi.spyOn(sharesKv, "put");
    const download = await app.fetch(new Request(share.url), env);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("still available");

    expect(putSpy).not.toHaveBeenCalled();
    expect(shareCounters.writesFor(share.tokenId)).toEqual([]);
  });

  it("reports 200 with headers for a continuation-shaped HEAD inside the resume window on an exhausted share", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/head-resume.txt", "0123456789");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/head-resume.txt",
      ttl: "1h",
      maxDownloads: 1,
    });

    const started = await app.fetch(new Request(share.url), env);
    expect(started.status).toBe(200);
    await started.text();

    const head = await app.fetch(
      new Request(share.url, { method: "HEAD", headers: { range: "bytes=5-" } }),
      env,
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe("10");
  });

  it("still reports 410 for a plain HEAD with no Range header on an exhausted share", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/head-plain-exhausted.txt", "0123456789");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/head-plain-exhausted.txt",
      ttl: "1h",
      maxDownloads: 1,
    });

    const started = await app.fetch(new Request(share.url), env);
    expect(started.status).toBe(200);
    await started.text();

    // Hono strips the body for a HEAD response even on an error status, so
    // only the status is checkable here (matches the existing HEAD tests).
    const head = await app.fetch(new Request(share.url, { method: "HEAD" }), env);
    expect(head.status).toBe(410);
  });

  it("returns 416, not 410, for an out-of-range Range request inside the resume window on an exhausted share", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/oob-resume.txt", "0123456789");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/oob-resume.txt",
      ttl: "1h",
      maxDownloads: 1,
    });

    const started = await app.fetch(new Request(share.url), env);
    expect(started.status).toBe(200);
    await started.text();

    const outOfRange = await app.fetch(
      new Request(share.url, { headers: { range: "bytes=1000-2000" } }),
      env,
    );
    expect(outOfRange.status).toBe(416);
  });

  it("returns 304, not 410, for a conditional GET with a continuation-shaped Range header on an exhausted share", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/conditional-resume.txt", "0123456789");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/conditional-resume.txt",
      ttl: "1h",
      maxDownloads: 1,
    });

    const stored = await bucket.head("docs/conditional-resume.txt");
    const started = await app.fetch(new Request(share.url), env);
    expect(started.status).toBe(200);
    await started.text();

    const conditional = await app.fetch(
      new Request(share.url, { headers: { "if-none-match": stored!.etag, range: "bytes=5-" } }),
      env,
    );
    expect(conditional.status).toBe(304);
  });

  it("returns 412, not 410, for a failing If-Match with a continuation-shaped Range header on an exhausted share", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/if-match-resume.txt", "0123456789");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/if-match-resume.txt",
      ttl: "1h",
      maxDownloads: 1,
    });

    const started = await app.fetch(new Request(share.url), env);
    expect(started.status).toBe(200);
    await started.text();

    const conditional = await app.fetch(
      new Request(share.url, { headers: { "if-match": '"wrong-etag"', range: "bytes=5-" } }),
      env,
    );
    expect(conditional.status).toBe(412);
  });

  it("still refuses a continuation-shaped HEAD when revoked, even inside the resume window", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/head-revoked-resume.txt", "0123456789");
    const app = createApp();

    const share = await createShareViaApi(app, env, {
      bucket: "files",
      key: "docs/head-revoked-resume.txt",
      ttl: "1h",
      maxDownloads: 1,
    });

    const started = await app.fetch(new Request(share.url), env);
    expect(started.status).toBe(200);
    await started.text();

    await app.fetch(
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

    const head = await app.fetch(
      new Request(share.url, { method: "HEAD", headers: { range: "bytes=5-" } }),
      env,
    );
    expect(head.status).toBe(410);
  });
});
