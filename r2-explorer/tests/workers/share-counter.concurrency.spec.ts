import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { Env } from "../../src/types";
import { accessHeaders, useWorkersAccessJwks } from "./helpers";

const testEnv = env as unknown as Env;

describe("share counter durable object under workerd", () => {
  useWorkersAccessJwks();

  it("serializes concurrent downloads so a maxDownloads=1 share serves exactly once", async () => {
    const app = createApp();
    await testEnv.FILES_BUCKET.put("docs/capped.txt", "capped body", {
      httpMetadata: { contentType: "text/plain" },
    });

    const createResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/share/create", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await accessHeaders({ email: "ops@example.com", scope: "r2.share.manage" })),
        },
        body: JSON.stringify({ key: "docs/capped.txt", ttl: "1h", maxDownloads: 1 }),
      }),
      testEnv,
    );
    expect(createResponse.status).toBe(200);
    const { tokenId } = (await createResponse.json()) as { tokenId: string };
    expect(tokenId).toBeTruthy();

    // Two truly concurrent downloads race for the single slot. The real
    // Durable Object input gate must serialize the read-modify-write; the
    // node suite proves this only against a fake with hand-coded atomicity.
    const [first, second] = await Promise.all([
      app.fetch(new Request(`https://files.example.com/share/${tokenId}`), testEnv),
      app.fetch(new Request(`https://files.example.com/share/${tokenId}`), testEnv),
    ]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 410]);

    const winner = first.status === 200 ? first : second;
    expect(await winner.text()).toBe("capped body");
    const loser = first.status === 200 ? second : first;
    const loserPayload = (await loser.json()) as { error?: { code?: string } };
    expect(loserPayload.error?.code).toBe("share_expired");

    // The cap holds after the race too.
    const third = await app.fetch(new Request(`https://files.example.com/share/${tokenId}`), testEnv);
    expect(third.status).toBe(410);
    await third.text();
  });

  it("counts sequential downloads up to the cap and no further", async () => {
    const app = createApp();
    await testEnv.FILES_BUCKET.put("docs/two.txt", "two downloads", {
      httpMetadata: { contentType: "text/plain" },
    });

    const createResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/share/create", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await accessHeaders({ email: "ops@example.com", scope: "r2.share.manage" })),
        },
        body: JSON.stringify({ key: "docs/two.txt", ttl: "1h", maxDownloads: 2 }),
      }),
      testEnv,
    );
    expect(createResponse.status).toBe(200);
    const { tokenId } = (await createResponse.json()) as { tokenId: string };

    for (const expected of [200, 200, 410]) {
      const response = await app.fetch(new Request(`https://files.example.com/share/${tokenId}`), testEnv);
      expect(response.status).toBe(expected);
      await response.text();
    }
  });

  it("serializes many concurrent download starts so maxDownloads is never exceeded", async () => {
    const app = createApp();
    await testEnv.FILES_BUCKET.put("docs/many.txt", "many body", {
      httpMetadata: { contentType: "text/plain" },
    });

    const createResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/share/create", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await accessHeaders({ email: "ops@example.com", scope: "r2.share.manage" })),
        },
        body: JSON.stringify({ key: "docs/many.txt", ttl: "1h", maxDownloads: 2 }),
      }),
      testEnv,
    );
    expect(createResponse.status).toBe(200);
    const { tokenId } = (await createResponse.json()) as { tokenId: string };

    const attempts = 6;
    const responses = await Promise.all(
      Array.from({ length: attempts }, () =>
        app.fetch(new Request(`https://files.example.com/share/${tokenId}`), testEnv),
      ),
    );
    const statuses = responses.map((response) => response.status);
    await Promise.all(responses.map((response) => response.text()));

    expect(statuses.filter((status) => status === 200)).toHaveLength(2);
    expect(statuses.filter((status) => status === 410)).toHaveLength(attempts - 2);
  });

  it("does not change the count for parallel Range continuations inside the resume window", async () => {
    const app = createApp();
    await testEnv.FILES_BUCKET.put("docs/parallel-resume.txt", "0123456789", {
      httpMetadata: { contentType: "text/plain" },
    });

    const createResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/share/create", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await accessHeaders({ email: "ops@example.com", scope: "r2.share.manage" })),
        },
        body: JSON.stringify({ key: "docs/parallel-resume.txt", ttl: "1h", maxDownloads: 6 }),
      }),
      testEnv,
    );
    expect(createResponse.status).toBe(200);
    const { tokenId } = (await createResponse.json()) as { tokenId: string };

    const started = await app.fetch(new Request(`https://files.example.com/share/${tokenId}`), testEnv);
    expect(started.status).toBe(200);
    await started.text();

    const attempts = 5;
    const responses = await Promise.all(
      Array.from({ length: attempts }, () =>
        app.fetch(
          new Request(`https://files.example.com/share/${tokenId}`, { headers: { range: "bytes=5-" } }),
          testEnv,
        ),
      ),
    );
    await Promise.all(responses.map((response) => response.text()));
    for (const response of responses) {
      expect(response.status).toBe(206);
    }

    // If any continuation above had wrongly consumed a slot, 1 start + 5
    // continuations would already exhaust the cap of 6; since continuations
    // inside the window are free, only 1 of 6 is spent, so one more fresh
    // start still succeeds.
    const finalDownload = await app.fetch(new Request(`https://files.example.com/share/${tokenId}`), testEnv);
    expect(finalDownload.status).toBe(200);
    await finalDownload.text();
  });
});
