import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { accessHeaders, createTestEnv, useAccessJwksFetchMock } from "./helpers/memory";

type ErrorPayload = { error?: { code?: string } };

describe("object routes", () => {
  useAccessJwksFetchMock();

  it("returns object metadata from /api/v2/meta", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/meta.txt", "metadata body", {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/meta?key=docs%2Fmeta.txt", {
        headers: accessHeaders(),
      }),
      env,
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      key: string;
      size: number;
      etag: string;
      uploaded: string | null;
      httpEtag: string | null;
    };
    expect(payload.key).toBe("docs/meta.txt");
    expect(payload.size).toBe("metadata body".length);
    expect(payload.etag.length).toBeGreaterThan(0);
    expect(payload.uploaded).toBeTruthy();
    expect(payload.httpEtag).toBeTruthy();
  });

  it("returns 404 object_not_found from /api/v2/meta for missing keys", async () => {
    const { env } = await createTestEnv();
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/meta?key=docs%2Fmissing.txt", {
        headers: accessHeaders(),
      }),
      env,
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as ErrorPayload).error?.code).toBe("object_not_found");
  });

  it("serves inline-previewable content types inline with nosniff", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/inline.txt", "inline text", {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/preview?key=docs%2Finline.txt", {
        headers: accessHeaders(),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("inline");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("inline text");
  });

  it("serves non-previewable content types as attachment from /api/v2/preview", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("bin/blob.bin", new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/preview?key=bin%2Fblob.bin", {
        headers: accessHeaders(),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("sends nosniff and a neutralizing CSP on /api/v2/download responses", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/dl.html", "<script>alert(1)</script>", {
      httpMetadata: { contentType: "text/html" },
    });
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/download?key=docs%2Fdl.html", {
        headers: accessHeaders(),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });

  it("sends a neutralizing CSP when previewing script-capable content inline", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/evil.html", "<script>alert(1)</script>", {
      httpMetadata: { contentType: "text/html" },
    });
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/preview?key=docs%2Fevil.html", {
        headers: accessHeaders(),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // Script-capable types must never render inline without a sandboxing CSP.
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });

  it("previews an inline-safe type without a CSP", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/notes.txt", "hello", {
      httpMetadata: { contentType: "text/plain" },
    });
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/preview?key=docs%2Fnotes.txt", {
        headers: accessHeaders(),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("inline");
    expect(response.headers.get("content-security-policy")).toBeNull();
  });

  it("moves objects with metadata via /api/v2/object/move", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/from.txt", "move me", {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/object/move", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders(),
        },
        body: JSON.stringify({ fromKey: "docs/from.txt", toKey: "docs/to.txt" }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ fromKey: "docs/from.txt", toKey: "docs/to.txt" });

    expect(await bucket.get("docs/from.txt")).toBeNull();
    const moved = await bucket.get("docs/to.txt");
    expect(moved).not.toBeNull();
    expect(await moved?.text()).toBe("move me");
  });

  it("rejects moving onto an existing destination without overwrite", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/move-src.txt", "source bytes");
    await bucket.put("docs/move-dst.txt", "destination bytes");
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/object/move", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders(),
        },
        body: JSON.stringify({ fromKey: "docs/move-src.txt", toKey: "docs/move-dst.txt" }),
      }),
      env,
    );
    const payload = (await response.json()) as { error: { code: string; details?: { key?: string } } };
    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("object_exists");
    expect(payload.error.details?.key).toBe("docs/move-dst.txt");
    // Nothing changed.
    expect(await (await bucket.get("docs/move-src.txt"))?.text()).toBe("source bytes");
    expect(await (await bucket.get("docs/move-dst.txt"))?.text()).toBe("destination bytes");
  });

  it("moves onto an existing destination with overwrite:true, trashing the prior object", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/ow-src.txt", "new bytes");
    await bucket.put("docs/ow-dst.txt", "old bytes");
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/object/move", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders(),
        },
        body: JSON.stringify({ fromKey: "docs/ow-src.txt", toKey: "docs/ow-dst.txt", overwrite: true }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await bucket.get("docs/ow-src.txt")).toBeNull();
    expect(await (await bucket.get("docs/ow-dst.txt"))?.text()).toBe("new bytes");

    // The prior destination object is recoverable under .trash/, same as delete.
    const trashed = await bucket.list({ prefix: ".trash/" });
    const trashedTexts = await Promise.all(
      trashed.objects.filter((object) => object.key.endsWith("docs/ow-dst.txt")).map(async (object) => {
        const stored = await bucket.get(object.key);
        return stored?.text();
      }),
    );
    expect(trashedTexts).toContain("old bytes");
  });

  it("fails the move without touching either object when overwrite's soft delete fails", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/fail-src.txt", "source bytes");
    await bucket.put("docs/fail-dst.txt", "destination bytes");
    const app = createApp();

    const originalPut = bucket.put.bind(bucket);
    bucket.put = async (key, value, options) => {
      if (key.startsWith(".trash/")) {
        throw new Error("simulated trash write failure");
      }
      return originalPut(key, value, options);
    };

    try {
      const response = await app.fetch(
        new Request("https://files.example.com/api/v2/object/move", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...accessHeaders(),
          },
          body: JSON.stringify({ fromKey: "docs/fail-src.txt", toKey: "docs/fail-dst.txt", overwrite: true }),
        }),
        env,
      );
      expect(response.status).toBe(500);
    } finally {
      bucket.put = originalPut;
    }

    expect(await (await bucket.get("docs/fail-src.txt"))?.text()).toBe("source bytes");
    expect(await (await bucket.get("docs/fail-dst.txt"))?.text()).toBe("destination bytes");
  });

  it("closes the check-then-act race for a non-overwrite move: a key that appears after the check yields 409 and leaves the concurrent write intact (RW-3)", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/race-src.txt", "moved content");
    await bucket.delete("docs/race-dst.txt");
    const app = createApp();

    // /object/move calls head(toKey) exactly once, so mockImplementationOnce
    // targets exactly that check (unlike upload's promotion sequence, which
    // has an earlier pre-assembly gate call too).
    const headSpy = vi.spyOn(bucket, "head").mockImplementationOnce(async () => {
      // Simulate a concurrent writer landing at toKey between this route's
      // existence check and moveObject's own copy.
      await bucket.put("docs/race-dst.txt", "concurrently written content");
      return null;
    });

    try {
      const response = await app.fetch(
        new Request("https://files.example.com/api/v2/object/move", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...accessHeaders(),
          },
          body: JSON.stringify({ fromKey: "docs/race-src.txt", toKey: "docs/race-dst.txt" }),
        }),
        env,
      );
      expect(response.status).toBe(409);
      const payload = (await response.json()) as { error?: { code?: string; details?: { key?: string } } };
      expect(payload.error?.code).toBe("object_exists");
      expect(payload.error?.details?.key).toBe("docs/race-dst.txt");

      expect(await (await bucket.get("docs/race-dst.txt"))?.text()).toBe("concurrently written content");
      expect(await (await bucket.get("docs/race-src.txt"))?.text()).toBe("moved content");
    } finally {
      headSpy.mockRestore();
    }
  });

  it("rejects moving an object onto itself", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/self.txt", "self");
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/object/move", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders(),
        },
        body: JSON.stringify({ fromKey: "docs/self.txt", toKey: "docs/self.txt" }),
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorPayload).error?.code).toBe("invalid_move");
  });

  it("rejects moving a missing source object", async () => {
    const { env } = await createTestEnv();
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/object/move", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders(),
        },
        body: JSON.stringify({ fromKey: "docs/absent.txt", toKey: "docs/anywhere.txt" }),
      }),
      env,
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as ErrorPayload).error?.code).toBe("object_not_found");
  });

  it("rejects moves that touch the reserved upload staging prefix", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/normal.txt", "normal");
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/object/move", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders(),
        },
        body: JSON.stringify({ fromKey: "docs/normal.txt", toKey: ".r2e-staging/session/docs/normal.txt" }),
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorPayload).error?.code).toBe("invalid_move");
  });

  it("rejects deletes that touch the reserved upload staging prefix", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put(".r2e-staging/session/docs/secret.bin", "staged bytes");
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/object/delete", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders(),
        },
        body: JSON.stringify({ key: ".r2e-staging/session/docs/secret.bin" }),
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorPayload).error?.code).toBe("invalid_delete");
    // The staged bytes survive the rejected delete.
    expect(await bucket.get(".r2e-staging/session/docs/secret.bin")).not.toBeNull();
  });

  it("rejects deletes that touch the reserved .git-annex/ prefix", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put(".git-annex/objects/abc", "annex content");
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/object/delete", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders(),
        },
        body: JSON.stringify({ key: ".git-annex/objects/abc" }),
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorPayload).error?.code).toBe("invalid_delete");
    expect(await bucket.get(".git-annex/objects/abc")).not.toBeNull();
  });

  it("rejects moves whose source is under the reserved .git-annex/ prefix", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put(".git-annex/objects/abc", "annex content");
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/object/move", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders(),
        },
        body: JSON.stringify({ fromKey: ".git-annex/objects/abc", toKey: "docs/exfiltrated.bin" }),
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorPayload).error?.code).toBe("invalid_move");
  });

  it("rejects moves whose destination is under the reserved .git-annex/ prefix", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/normal2.txt", "normal");
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/object/move", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeaders(),
        },
        body: JSON.stringify({ fromKey: "docs/normal2.txt", toKey: ".git-annex/objects/injected" }),
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorPayload).error?.code).toBe("invalid_move");
  });

  it("downloads an object whose key has CJK characters without throwing", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/日本語.txt", "cjk body");
    const app = createApp();

    const response = await app.fetch(
      new Request(`https://files.example.com/api/v2/download?key=${encodeURIComponent("docs/日本語.txt")}`, {
        headers: accessHeaders(),
      }),
      env,
    );
    expect(response.status).toBe(200);
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toContain('filename="');
    expect(disposition).toContain("filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.txt");
  });

  it("downloads an object whose key has an emoji without throwing", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/party-🎉.txt", "emoji body");
    const app = createApp();

    const response = await app.fetch(
      new Request(`https://files.example.com/api/v2/download?key=${encodeURIComponent("docs/party-🎉.txt")}`, {
        headers: accessHeaders(),
      }),
      env,
    );
    expect(response.status).toBe(200);
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).not.toContain("🎉");
  });

  it("previews an object whose key has a quote, backslash, CR/LF, and a percent sign", async () => {
    const { env, bucket } = await createTestEnv();
    const key = 'docs/a"b\\c%d.txt';
    await bucket.put(key, "weird name body", { httpMetadata: { contentType: "text/plain" } });
    const app = createApp();

    const response = await app.fetch(
      new Request(`https://files.example.com/api/v2/preview?key=${encodeURIComponent(key)}`, {
        headers: accessHeaders(),
      }),
      env,
    );
    expect(response.status).toBe(200);
    const disposition = response.headers.get("content-disposition") ?? "";
    // The plain filename= parameter must never contain an unescaped quote or
    // backslash: both are structural characters in an HTTP quoted-string.
    expect(disposition).toMatch(/filename="a_b_c%d\.txt"/);
  });

  it("round-trips a truncated multi-page list via cursors", async () => {
    const { env, bucket } = await createTestEnv();
    const keys = ["page/a.txt", "page/b.txt", "page/c.txt", "page/d.txt", "page/e.txt"];
    for (const key of keys) {
      await bucket.put(key, `content:${key}`);
    }
    const app = createApp();

    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const url = new URL("https://files.example.com/api/v2/list");
      url.searchParams.set("prefix", "page/");
      url.searchParams.set("limit", "2");
      if (cursor) {
        url.searchParams.set("cursor", cursor);
      }
      const response = await app.fetch(new Request(url.toString(), { headers: accessHeaders() }), env);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        objects: Array<{ key: string }>;
        cursor?: string;
        listComplete: boolean;
      };
      pages += 1;
      collected.push(...payload.objects.map((object) => object.key));
      if (payload.listComplete) {
        expect(payload.cursor).toBeUndefined();
        break;
      }
      expect(payload.cursor).toBeTruthy();
      expect(payload.objects.length).toBe(2);
      cursor = payload.cursor;
    }

    expect(pages).toBe(3);
    expect(collected).toEqual(keys);
  });

  it("returns a 206 partial response for a Range request, with Content-Range and Accept-Ranges", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/ranged.bin", "0123456789abcdef");
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/download?key=docs%2Franged.bin", {
        headers: { ...accessHeaders(), range: "bytes=2-5" },
      }),
      env,
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe("bytes 2-5/16");
    expect(response.headers.get("content-length")).toBe("4");
    expect(await response.text()).toBe("2345");
  });

  it("sends Accept-Ranges on a plain (non-Range) download", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/plain.bin", "plain body");
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/download?key=docs%2Fplain.bin", { headers: accessHeaders() }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(await response.text()).toBe("plain body");
  });

  it("returns 304 when If-None-Match matches the current ETag", async () => {
    const { env, bucket } = await createTestEnv();
    const stored = await bucket.put("docs/etag.txt", "etag body");
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/download?key=docs%2Fetag.txt", {
        headers: { ...accessHeaders(), "if-none-match": `"${stored.httpEtag}"` },
      }),
      env,
    );
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
  });

  it("returns 412 when If-Match does not match the current ETag", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/precond.txt", "precondition body");
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/download?key=docs%2Fprecond.txt", {
        headers: { ...accessHeaders(), "if-match": '"not-the-real-etag"' },
      }),
      env,
    );
    expect(response.status).toBe(412);
  });

  it("returns 412 when If-Unmodified-Since is before the object's upload time", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/unmodified.txt", "unmodified body");
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/download?key=docs%2Funmodified.txt", {
        headers: { ...accessHeaders(), "if-unmodified-since": new Date(0).toUTCString() },
      }),
      env,
    );
    expect(response.status).toBe(412);
  });

  it("returns 416 with Content-Range for an unsatisfiable range", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/short.bin", "0123456789");
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/download?key=docs%2Fshort.bin", {
        headers: { ...accessHeaders(), range: "bytes=1000-2000" },
      }),
      env,
    );
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */10");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
  });

  it("answers HEAD on /api/v2/download without fetching or sending a body", async () => {
    const { env, bucket } = await createTestEnv();
    await bucket.put("docs/head.txt", "head body");
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/download?key=docs%2Fhead.txt", {
        method: "HEAD",
        headers: accessHeaders(),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String("head body".length));
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(await response.text()).toBe("");
  });

  it("answers HEAD on /api/v2/preview with a 304 for a matching If-None-Match, no body", async () => {
    const { env, bucket } = await createTestEnv();
    const stored = await bucket.put("docs/head-etag.txt", "head etag body");
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/preview?key=docs%2Fhead-etag.txt", {
        method: "HEAD",
        headers: { ...accessHeaders(), "if-none-match": `"${stored.httpEtag}"` },
      }),
      env,
    );
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
  });
});
