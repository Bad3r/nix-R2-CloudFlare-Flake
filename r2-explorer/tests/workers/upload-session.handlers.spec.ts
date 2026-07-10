import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { stagingObjectKey } from "../../src/routes/upload";
import type { Env } from "../../src/types";
import { jsonMutationHeaders, useWorkersAccessJwks, type WorkersAccessJwtOptions } from "./helpers";

const testEnv = env as unknown as Env;

type ErrorPayload = { error?: { code?: string } };
type InitPayload = {
  sessionId: string;
  uploadId: string;
  objectKey: string;
  partSizeBytes: number;
};

type App = ReturnType<typeof createApp>;

async function initUpload(
  app: App,
  targetEnv: Env,
  options?: {
    filename?: string;
    prefix?: string;
    declaredSize?: number;
    auth?: WorkersAccessJwtOptions;
  },
): Promise<Response> {
  return app.fetch(
    new Request("https://files.example.com/api/v2/upload/init", {
      method: "POST",
      headers: await jsonMutationHeaders(options?.auth),
      body: JSON.stringify({
        filename: options?.filename ?? "sample.bin",
        prefix: options?.prefix ?? "uploads/",
        declaredSize: options?.declaredSize ?? 16,
        contentType: "application/octet-stream",
      }),
    }),
    targetEnv,
  );
}

describe("upload session durable object under workerd", () => {
  useWorkersAccessJwks();

  // Sessions live in a per-owner durable object whose storage persists across
  // tests in this pool, so every test uses its own Access sub for isolation.

  it("runs init/sign/complete against the real store and rejects abort-after-complete", async () => {
    const app = createApp();
    const auth = { email: "complete@example.com", sub: "user-complete" };

    const initResponse = await initUpload(app, testEnv, { filename: "complete.bin", auth });
    expect(initResponse.status).toBe(200);
    const init = (await initResponse.json()) as InitPayload;
    expect(init.sessionId).toBeTruthy();
    expect(init.objectKey).toBe("uploads/complete.bin");

    const partBytes = new Uint8Array(16).fill(65);
    const signResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/sign-part", {
        method: "POST",
        headers: await jsonMutationHeaders(auth),
        body: JSON.stringify({
          sessionId: init.sessionId,
          uploadId: init.uploadId,
          partNumber: 1,
          contentLength: partBytes.byteLength,
        }),
      }),
      testEnv,
    );
    expect(signResponse.status).toBe(200);

    const upload = testEnv.FILES_BUCKET.resumeMultipartUpload(
      stagingObjectKey(init.sessionId, init.objectKey),
      init.uploadId,
    );
    const uploadedPart = await upload.uploadPart(1, partBytes);

    const completeResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/complete", {
        method: "POST",
        headers: await jsonMutationHeaders(auth),
        body: JSON.stringify({
          sessionId: init.sessionId,
          uploadId: init.uploadId,
          finalSize: partBytes.byteLength,
          parts: [{ partNumber: 1, etag: uploadedPart.etag }],
        }),
      }),
      testEnv,
    );
    expect(completeResponse.status).toBe(200);
    const complete = (await completeResponse.json()) as { key: string; size: number };
    expect(complete.key).toBe(init.objectKey);
    expect(complete.size).toBe(partBytes.byteLength);

    const stored = await testEnv.FILES_BUCKET.get(init.objectKey);
    expect(stored).not.toBeNull();
    expect(await stored?.text()).toBe("A".repeat(16));

    // The real handler must refuse to abort a completed session.
    const abortResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/abort", {
        method: "POST",
        headers: await jsonMutationHeaders(auth),
        body: JSON.stringify({ sessionId: init.sessionId, uploadId: init.uploadId }),
      }),
      testEnv,
    );
    expect(abortResponse.status).toBe(409);
    expect(((await abortResponse.json()) as ErrorPayload).error?.code).toBe(
      "upload_session_already_completed",
    );
  });

  it("rejects a second active session targeting the same object key", async () => {
    const app = createApp();

    const auth = { email: "dupe@example.com", sub: "user-dupe" };
    const first = await initUpload(app, testEnv, { filename: "duplicate.bin", auth });
    expect(first.status).toBe(200);
    await first.text();

    const second = await initUpload(app, testEnv, { filename: "duplicate.bin", auth });
    expect(second.status).toBe(409);
    expect(((await second.json()) as ErrorPayload).error?.code).toBe("upload_object_key_in_use");
  });

  it("enforces the per-user concurrency cap with 429", async () => {
    const app = createApp();
    const cappedEnv = { ...testEnv, R2E_UPLOAD_MAX_CONCURRENT_PER_USER: "1" } as Env;

    const auth = { email: "cap@example.com", sub: "user-cap" };
    const first = await initUpload(app, cappedEnv, { filename: "cap-a.bin", auth });
    expect(first.status).toBe(200);
    await first.text();

    const second = await initUpload(app, cappedEnv, { filename: "cap-b.bin", auth });
    expect(second.status).toBe(429);
    expect(((await second.json()) as ErrorPayload).error?.code).toBe("upload_concurrency_limit");
  });

  it("aborts an active session and refuses further signing", async () => {
    const app = createApp();

    const auth = { email: "abort@example.com", sub: "user-abort" };
    const initResponse = await initUpload(app, testEnv, { filename: "aborted.bin", auth });
    expect(initResponse.status).toBe(200);
    const init = (await initResponse.json()) as InitPayload;

    const abortResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/abort", {
        method: "POST",
        headers: await jsonMutationHeaders(auth),
        body: JSON.stringify({ sessionId: init.sessionId, uploadId: init.uploadId }),
      }),
      testEnv,
    );
    expect(abortResponse.status).toBe(200);
    await abortResponse.text();

    const signResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/sign-part", {
        method: "POST",
        headers: await jsonMutationHeaders(auth),
        body: JSON.stringify({
          sessionId: init.sessionId,
          uploadId: init.uploadId,
          partNumber: 1,
          contentLength: 16,
        }),
      }),
      testEnv,
    );
    expect(signResponse.status).toBe(409);
    expect(((await signResponse.json()) as ErrorPayload).error?.code).toBe("upload_session_not_active");
  });

  it("isolates sessions per owner so another user cannot touch them", async () => {
    const app = createApp();

    const initResponse = await initUpload(app, testEnv, {
      filename: "owned.bin",
      auth: { email: "owner@example.com", sub: "user-owner" },
    });
    expect(initResponse.status).toBe(200);
    const init = (await initResponse.json()) as InitPayload;

    // A different Access identity resolves a different per-owner durable
    // object, so the session must be invisible to it.
    const foreignSign = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/sign-part", {
        method: "POST",
        headers: await jsonMutationHeaders({ email: "intruder@example.com", sub: "user-intruder" }),
        body: JSON.stringify({
          sessionId: init.sessionId,
          uploadId: init.uploadId,
          partNumber: 1,
          contentLength: 16,
        }),
      }),
      testEnv,
    );
    expect(foreignSign.status).toBe(404);
    expect(((await foreignSign.json()) as ErrorPayload).error?.code).toBe("upload_session_not_found");
  });
});
