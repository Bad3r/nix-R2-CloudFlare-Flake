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
      new Request("https://files.example.com/api/object/delete", {
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
      new Request("https://files.example.com/api/list?prefix=docs/1", {
        headers: accessHeaders(),
      }),
      env,
    );
    expect(listResponse.status).toBe(200);
  });
});
