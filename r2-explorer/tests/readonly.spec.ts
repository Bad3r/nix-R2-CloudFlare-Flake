import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { accessHeaders, createTestEnv, useAccessJwksFetchMock } from "./helpers/memory";

describe("readonly middleware", () => {
  useAccessJwksFetchMock();

  it("blocks API mutations when R2E_READONLY=true", async () => {
    const { env, bucket } = await createTestEnv();
    env.R2E_READONLY = "true";
    await bucket.put("docs/readonly.txt", "readonly");
    const app = createApp();

    const deleteResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/object/delete", {
        method: "POST",
        headers: {
          ...accessHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ key: "docs/readonly.txt" }),
      }),
      env,
    );
    const deletePayload = (await deleteResponse.json()) as { error: { code: string } };
    expect(deleteResponse.status).toBe(403);
    expect(deletePayload.error.code).toBe("readonly_mode");
  });

  it("permits readonly-safe routes when R2E_READONLY=true", async () => {
    const { env, bucket } = await createTestEnv();
    env.R2E_READONLY = "true";
    await bucket.put("docs/listable.txt", "ok");
    const app = createApp();

    const listResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/list?prefix=docs/1", {
        headers: accessHeaders(),
      }),
      env,
    );
    expect(listResponse.status).toBe(200);
  });

  it("fails fast instead of silently disabling readonly mode on an unrecognized R2E_READONLY value", async () => {
    const { env, bucket } = await createTestEnv();
    env.R2E_READONLY = "tru";
    await bucket.put("docs/typo.txt", "still here");
    const app = createApp();

    const deleteResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/object/delete", {
        method: "POST",
        headers: {
          ...accessHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ key: "docs/typo.txt" }),
      }),
      env,
    );
    const payload = (await deleteResponse.json()) as { error: { code: string; message: string } };
    expect(deleteResponse.status).toBe(500);
    expect(payload.error.code).toBe("config_invalid");
    expect(payload.error.message).toContain("R2E_READONLY");
    // The delete must not have gone through while config was rejected.
    expect(await bucket.get("docs/typo.txt")).not.toBeNull();
  });
});
