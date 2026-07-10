import { describe, expect, it } from "vitest";
import { ShareCounterDurableObject } from "../src/share/counter";
import { createMemoryDurableObjectState } from "./helpers/memory";

const COUNTER_RETENTION_MS = 24 * 60 * 60 * 1000;

function consumeRequest(body: Record<string, unknown>): Request {
  return new Request("https://share-counter/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("ShareCounterDurableObject", () => {
  it("increments up to maxDownloads and then rejects with share_expired", async () => {
    const { state } = createMemoryDurableObjectState();
    const counter = new ShareCounterDurableObject(state);
    const expiresAtMs = Date.now() + 3600_000;

    for (let expected = 1; expected <= 3; expected += 1) {
      const response = await counter.fetch(
        consumeRequest({ tokenId: "token-a", maxDownloads: 3, expiresAtMs }),
      );
      expect(response.status).toBe(200);
      expect(((await response.json()) as { count: number }).count).toBe(expected);
    }

    const exhausted = await counter.fetch(
      consumeRequest({ tokenId: "token-a", maxDownloads: 3, expiresAtMs }),
    );
    expect(exhausted.status).toBe(410);
    expect(((await exhausted.json()) as { error: { code: string } }).error.code).toBe("share_expired");
  });

  it("seeds the authoritative count from the KV downloadCount on first consume", async () => {
    const { state, storage } = createMemoryDurableObjectState();
    const counter = new ShareCounterDurableObject(state);
    const expiresAtMs = Date.now() + 3600_000;

    // A share migrated from the old KV-only accounting has already served 2 of
    // 3 downloads; the fresh DO must not restart at 0 and regrant full quota.
    const first = await counter.fetch(
      consumeRequest({ tokenId: "token-migrated", maxDownloads: 3, expiresAtMs, downloadCount: 2 }),
    );
    expect(first.status).toBe(200);
    expect(((await first.json()) as { count: number }).count).toBe(3);
    expect(await storage.get<number>("count")).toBe(3);

    const exhausted = await counter.fetch(
      consumeRequest({ tokenId: "token-migrated", maxDownloads: 3, expiresAtMs, downloadCount: 2 }),
    );
    expect(exhausted.status).toBe(410);
    expect(((await exhausted.json()) as { error: { code: string } }).error.code).toBe("share_expired");
  });

  it("ignores the KV seed once the durable object holds its own count", async () => {
    const { state } = createMemoryDurableObjectState();
    const counter = new ShareCounterDurableObject(state);
    const expiresAtMs = Date.now() + 3600_000;

    const first = await counter.fetch(
      consumeRequest({ tokenId: "token-live", maxDownloads: 5, expiresAtMs, downloadCount: 0 }),
    );
    expect(((await first.json()) as { count: number }).count).toBe(1);

    // A later request carrying a stale, higher KV seed must not override the
    // DO's own stored count.
    const second = await counter.fetch(
      consumeRequest({ tokenId: "token-live", maxDownloads: 5, expiresAtMs, downloadCount: 4 }),
    );
    expect(((await second.json()) as { count: number }).count).toBe(2);
  });

  it("keeps counting unlimited shares without a cap", async () => {
    const { state } = createMemoryDurableObjectState();
    const counter = new ShareCounterDurableObject(state);
    const expiresAtMs = Date.now() + 3600_000;

    for (let expected = 1; expected <= 5; expected += 1) {
      const response = await counter.fetch(
        consumeRequest({ tokenId: "token-b", maxDownloads: 0, expiresAtMs }),
      );
      expect(response.status).toBe(200);
      expect(((await response.json()) as { count: number }).count).toBe(expected);
    }
  });

  it("rejects consumption for expired tokens", async () => {
    const { state } = createMemoryDurableObjectState();
    const counter = new ShareCounterDurableObject(state);

    const response = await counter.fetch(
      consumeRequest({ tokenId: "token-c", maxDownloads: 1, expiresAtMs: Date.now() - 1000 }),
    );
    expect(response.status).toBe(410);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("share_expired");
  });

  it("schedules a cleanup alarm and wipes storage when it fires", async () => {
    const { state, storage } = createMemoryDurableObjectState();
    const counter = new ShareCounterDurableObject(state);
    const expiresAtMs = Date.now() + 3600_000;

    const response = await counter.fetch(
      consumeRequest({ tokenId: "token-d", maxDownloads: 2, expiresAtMs }),
    );
    expect(response.status).toBe(200);
    expect(await storage.getAlarm()).toBe(expiresAtMs + COUNTER_RETENTION_MS);
    expect(await storage.get<number>("count")).toBe(1);

    await counter.alarm();
    expect(await storage.get<number>("count")).toBeUndefined();
    expect(await storage.getAlarm()).toBeNull();
  });

  it("rejects non-POST methods and unknown routes", async () => {
    const { state } = createMemoryDurableObjectState();
    const counter = new ShareCounterDurableObject(state);

    const wrongMethod = await counter.fetch(new Request("https://share-counter/consume", { method: "GET" }));
    expect(wrongMethod.status).toBe(405);

    const wrongPath = await counter.fetch(
      new Request("https://share-counter/unknown", { method: "POST", body: "{}" }),
    );
    expect(wrongPath.status).toBe(404);
  });

  it("rejects malformed consume payloads with validation_error", async () => {
    const { state } = createMemoryDurableObjectState();
    const counter = new ShareCounterDurableObject(state);

    const response = await counter.fetch(
      consumeRequest({ tokenId: "", maxDownloads: -1, expiresAtMs: Number.NaN }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("validation_error");
  });
});
