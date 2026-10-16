import { describe, expect, it, vi } from "vitest";
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

function statusRequest(body: Record<string, unknown>): Request {
  return new Request("https://share-counter/status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function revokeRequest(body: Record<string, unknown>): Request {
  return new Request("https://share-counter/revoke", {
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

  it("does not consume a slot for a continuation within the resume window, even once the cap is reached", async () => {
    const { state } = createMemoryDurableObjectState();
    const counter = new ShareCounterDurableObject(state);
    const expiresAtMs = Date.now() + 3600_000;

    const start = await counter.fetch(
      consumeRequest({
        tokenId: "token-resume",
        maxDownloads: 1,
        expiresAtMs,
        isContinuation: false,
        resumeWindowMs: 900_000,
      }),
    );
    expect(start.status).toBe(200);
    expect(await start.json()).toEqual({ count: 1, consumed: true });

    const resumed = await counter.fetch(
      consumeRequest({
        tokenId: "token-resume",
        maxDownloads: 1,
        expiresAtMs,
        isContinuation: true,
        resumeWindowMs: 900_000,
      }),
    );
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({ count: 1, consumed: false });
  });

  it("treats a continuation outside the resume window as a fresh start, refusing it once the cap is reached", async () => {
    const { state } = createMemoryDurableObjectState();
    const counter = new ShareCounterDurableObject(state);
    const expiresAtMs = Date.now() + 3600_000;

    await counter.fetch(
      consumeRequest({
        tokenId: "token-cold",
        maxDownloads: 1,
        expiresAtMs,
        isContinuation: false,
        resumeWindowMs: 900_000,
      }),
    );

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 900_001);
      const resumed = await counter.fetch(
        consumeRequest({
          tokenId: "token-cold",
          maxDownloads: 1,
          expiresAtMs,
          isContinuation: true,
          resumeWindowMs: 900_000,
        }),
      );
      expect(resumed.status).toBe(410);
      expect(((await resumed.json()) as { error: { code: string } }).error.code).toBe("share_expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a continuation with no prior recorded start as a fresh start", async () => {
    const { state } = createMemoryDurableObjectState();
    const counter = new ShareCounterDurableObject(state);
    const expiresAtMs = Date.now() + 3600_000;

    const response = await counter.fetch(
      consumeRequest({
        tokenId: "token-fresh-continuation",
        maxDownloads: 5,
        expiresAtMs,
        isContinuation: true,
        resumeWindowMs: 900_000,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 1, consumed: true });
  });

  it("reports exhausted and revoked status without mutating storage", async () => {
    const { state, storage } = createMemoryDurableObjectState();
    const counter = new ShareCounterDurableObject(state);
    const expiresAtMs = Date.now() + 3600_000;

    await counter.fetch(consumeRequest({ tokenId: "token-status", maxDownloads: 1, expiresAtMs }));

    const status = await counter.fetch(statusRequest({ tokenId: "token-status", maxDownloads: 1, expiresAtMs }));
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ revoked: false, exhausted: true, count: 1 });
    expect(await storage.get<number>("count")).toBe(1);

    const expiredStatus = await counter.fetch(
      statusRequest({ tokenId: "token-status", maxDownloads: 100, expiresAtMs: Date.now() - 1 }),
    );
    expect((await expiredStatus.json()) as { exhausted: boolean }).toMatchObject({ exhausted: true });
  });

  it("revoke sets an authoritative flag that blocks future consume calls and is idempotent", async () => {
    const { state } = createMemoryDurableObjectState();
    const counter = new ShareCounterDurableObject(state);
    const expiresAtMs = Date.now() + 3600_000;

    const first = await counter.fetch(revokeRequest({ tokenId: "token-revoke", expiresAtMs }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ revoked: true });

    const second = await counter.fetch(revokeRequest({ tokenId: "token-revoke", expiresAtMs }));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ revoked: true });

    const consume = await counter.fetch(consumeRequest({ tokenId: "token-revoke", maxDownloads: 0, expiresAtMs }));
    expect(consume.status).toBe(410);
    expect(((await consume.json()) as { error: { code: string } }).error.code).toBe("share_expired");

    const status = await counter.fetch(statusRequest({ tokenId: "token-revoke", maxDownloads: 0, expiresAtMs }));
    expect((await status.json()) as { revoked: boolean }).toMatchObject({ revoked: true });
  });

  it("refuses a continuation once revoked, even inside the resume window", async () => {
    const { state } = createMemoryDurableObjectState();
    const counter = new ShareCounterDurableObject(state);
    const expiresAtMs = Date.now() + 3600_000;

    await counter.fetch(
      consumeRequest({
        tokenId: "token-revoked-resume",
        maxDownloads: 1,
        expiresAtMs,
        isContinuation: false,
        resumeWindowMs: 900_000,
      }),
    );
    await counter.fetch(revokeRequest({ tokenId: "token-revoked-resume", expiresAtMs }));

    const resumed = await counter.fetch(
      consumeRequest({
        tokenId: "token-revoked-resume",
        maxDownloads: 1,
        expiresAtMs,
        isContinuation: true,
        resumeWindowMs: 900_000,
      }),
    );
    expect(resumed.status).toBe(410);
    expect(((await resumed.json()) as { error: { code: string } }).error.code).toBe("share_expired");
  });

  it("treats a counter holding only a legacy count as having no prior recorded start", async () => {
    const { state, storage } = createMemoryDurableObjectState();
    await storage.put("count", 1);
    const counter = new ShareCounterDurableObject(state);
    const expiresAtMs = Date.now() + 3600_000;

    const resumed = await counter.fetch(
      consumeRequest({
        tokenId: "token-legacy",
        maxDownloads: 1,
        expiresAtMs,
        isContinuation: true,
        resumeWindowMs: 900_000,
      }),
    );
    expect(resumed.status).toBe(410);
    expect(((await resumed.json()) as { error: { code: string } }).error.code).toBe("share_expired");
  });

  it("reports not exhausted for a continuation-shaped status check within the resume window on an exhausted share", async () => {
    const { state } = createMemoryDurableObjectState();
    const counter = new ShareCounterDurableObject(state);
    const expiresAtMs = Date.now() + 3600_000;

    await counter.fetch(consumeRequest({ tokenId: "token-status-resume", maxDownloads: 1, expiresAtMs }));

    const status = await counter.fetch(
      statusRequest({
        tokenId: "token-status-resume",
        maxDownloads: 1,
        expiresAtMs,
        isContinuation: true,
        resumeWindowMs: 900_000,
      }),
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ revoked: false, exhausted: false, count: 1 });
  });

  it("still reports exhausted for a continuation-shaped status check outside the resume window", async () => {
    const { state } = createMemoryDurableObjectState();
    const counter = new ShareCounterDurableObject(state);
    const expiresAtMs = Date.now() + 3600_000;

    await counter.fetch(consumeRequest({ tokenId: "token-status-cold", maxDownloads: 1, expiresAtMs }));

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 900_001);
      const status = await counter.fetch(
        statusRequest({
          tokenId: "token-status-cold",
          maxDownloads: 1,
          expiresAtMs,
          isContinuation: true,
          resumeWindowMs: 900_000,
        }),
      );
      expect(status.status).toBe(200);
      expect((await status.json()) as { exhausted: boolean }).toMatchObject({ exhausted: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports exhausted for a non-continuation status check even within the resume window", async () => {
    const { state } = createMemoryDurableObjectState();
    const counter = new ShareCounterDurableObject(state);
    const expiresAtMs = Date.now() + 3600_000;

    await counter.fetch(consumeRequest({ tokenId: "token-status-start", maxDownloads: 1, expiresAtMs }));

    const status = await counter.fetch(
      statusRequest({
        tokenId: "token-status-start",
        maxDownloads: 1,
        expiresAtMs,
        isContinuation: false,
        resumeWindowMs: 900_000,
      }),
    );
    expect((await status.json()) as { exhausted: boolean }).toMatchObject({ exhausted: true });
  });

  it("reports expired regardless of the continuation exemption", async () => {
    const { state } = createMemoryDurableObjectState();
    const counter = new ShareCounterDurableObject(state);

    const status = await counter.fetch(
      statusRequest({
        tokenId: "token-status-expired",
        maxDownloads: 0,
        expiresAtMs: Date.now() - 1,
        isContinuation: true,
        resumeWindowMs: 900_000,
      }),
    );
    expect((await status.json()) as { exhausted: boolean }).toMatchObject({ exhausted: true });
  });
});
