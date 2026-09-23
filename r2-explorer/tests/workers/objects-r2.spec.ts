import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import type { Env } from "../../src/types";
import { accessHeaders, jsonMutationHeaders, useWorkersAccessJwks } from "./helpers";

const testEnv = env as unknown as Env;

describe("R2 conditional put under real workerd (RW-3)", () => {
  it("resolves null instead of throwing when a wildcard If-None-Match condition fails", async () => {
    const bucket = testEnv.FILES_BUCKET;
    const key = "conditional-put-probe.bin";
    await bucket.put(key, "existing");
    try {
      const result = await bucket.put(key, "new bytes", {
        onlyIf: new Headers({ "if-none-match": "*" }),
      });
      expect(result).toBeNull();
      // The existing object must be untouched: the conditional put never wrote.
      const stillThere = await bucket.get(key);
      expect(await stillThere?.text()).toBe("existing");
    } finally {
      await bucket.delete(key);
    }
  });

  it("succeeds and writes when the wildcard If-None-Match condition holds (key absent)", async () => {
    const bucket = testEnv.FILES_BUCKET;
    const key = "conditional-put-absent-probe.bin";
    await bucket.delete(key);
    try {
      const result = await bucket.put(key, "created", {
        onlyIf: new Headers({ "if-none-match": "*" }),
      });
      expect(result).not.toBeNull();
      const stored = await bucket.get(key);
      expect(await stored?.text()).toBe("created");
    } finally {
      await bucket.delete(key);
    }
  });
});

describe("unread R2 bodies under real workerd", () => {
  useWorkersAccessJwks();

  it("cancels the real R2 stream behind a HEAD answer and a 304 precondition recheck", async () => {
    const app = createApp();
    const bucket = testEnv.FILES_BUCKET;
    const key = "workerd-unread-body.txt";
    const stored = await bucket.put(key, "unread body");
    const url = `https://files.example.com/api/v2/download?key=${encodeURIComponent(key)}`;
    const errorSpy = vi.spyOn(console, "error");
    try {
      const head = await app.fetch(new Request(url, { method: "HEAD", headers: await accessHeaders() }), testEnv);
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String("unread body".length));
      expect(await head.text()).toBe("");

      const recheck = await app.fetch(
        new Request(url, {
          headers: {
            ...(await accessHeaders()),
            "if-match": stored?.httpEtag ?? "",
            "if-none-match": stored?.httpEtag ?? "",
          },
        }),
        testEnv,
      );
      expect(recheck.status).toBe(304);

      const cancelFailures = errorSpy.mock.calls.filter(([message]) =>
        String(message).includes("Failed to cancel the unread body"),
      );
      expect(cancelFailures).toEqual([]);
    } finally {
      errorSpy.mockRestore();
      await bucket.delete(key);
    }
  });
});

describe("POST /api/v2/object/move under real workerd (RW-3)", () => {
  useWorkersAccessJwks();

  it("closes the check-then-act race: a key that appears after the head check yields 409 and leaves the concurrent write intact", async () => {
    const app = createApp();
    const bucket = testEnv.FILES_BUCKET;
    const fromKey = "workerd-race-source.bin";
    const toKey = "workerd-race-dest.bin";
    await bucket.put(fromKey, "moved content");
    await bucket.delete(toKey);

    const headSpy = vi.spyOn(bucket, "head").mockImplementationOnce(async (key: string) => {
      // Simulate a concurrent writer landing at toKey between this route's
      // existence check and the copy that follows it.
      await bucket.put(toKey, "concurrently written content");
      return null;
    });

    try {
      const response = await app.fetch(
        new Request("https://files.example.com/api/v2/object/move", {
          method: "POST",
          headers: await jsonMutationHeaders(),
          body: JSON.stringify({ fromKey, toKey }),
        }),
        testEnv,
      );
      expect(response.status).toBe(409);
      const payload = (await response.json()) as { error?: { code?: string; details?: { key?: string } } };
      expect(payload.error?.code).toBe("object_exists");
      expect(payload.error?.details?.key).toBe(toKey);

      const destination = await bucket.get(toKey);
      expect(await destination?.text()).toBe("concurrently written content");
      const source = await bucket.get(fromKey);
      expect(await source?.text()).toBe("moved content");
    } finally {
      headSpy.mockRestore();
      await bucket.delete(fromKey);
      await bucket.delete(toKey);
    }
  });
});
