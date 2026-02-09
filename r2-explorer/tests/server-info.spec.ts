import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { accessHeaders, createTestEnv, useAccessJwksFetchMock } from "./helpers/memory";

describe("server info endpoint", () => {
  useAccessJwksFetchMock();

  it("returns runtime capabilities and limits", async () => {
    const { env } = await createTestEnv();
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/server/info", {
        headers: accessHeaders("ops@example.com"),
      }),
      env,
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      version: string;
      readonly: boolean;
      actor: { mode: string; actor: string };
      share: { mode: string };
      limits: { maxShareTtlSec: number };
    };
    expect(payload.version).toBeTruthy();
    expect(payload.readonly).toBe(false);
    expect(payload.actor.actor).toBe("ops@example.com");
    expect(payload.actor.mode).toBe("access");
    expect(payload.share.mode).toBe("kv-random-token");
    expect(payload.limits.maxShareTtlSec).toBe(2592000);
  });
});
