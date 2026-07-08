import { describe, expect, it } from "vitest";
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
});
