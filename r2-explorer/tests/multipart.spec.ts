import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { promoteObject } from "../src/r2";
import { stagingObjectKey } from "../src/routes/upload";
import {
  MemoryR2Bucket,
  accessHeaders,
  accessSessionCookie,
  createAccessJwt,
  createTestEnv,
  useAccessJwksFetchMock,
} from "./helpers/memory";

type InitPayload = {
  sessionId: string;
  uploadId: string;
  objectKey: string;
  partSizeBytes: number;
  maxParts: number;
};

type ErrorPayload = { error?: { code?: string } };

function md5Base64(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("base64");
}

function uploadHeaders(options?: {
  email?: string;
  sub?: string;
  origin?: string | null;
  csrf?: string | null;
  contentType?: string;
}): HeadersInit {
  const email = options?.email ?? "engineer@example.com";
  const sub = options?.sub ?? "user-a";
  const headers: Record<string, string> = {
    ...(accessHeaders(email, { sub }) as Record<string, string>),
    "content-type": options?.contentType ?? "application/json",
  };
  if (options?.origin !== null) {
    headers.origin = options?.origin ?? "https://files.example.com";
  }
  if (options?.csrf !== null) {
    headers["x-r2e-csrf"] = options?.csrf ?? "1";
  }
  return headers;
}

function uploadCookieHeaders(
  _env: Awaited<ReturnType<typeof createTestEnv>>["env"],
  options?: {
    email?: string;
    sub?: string;
    origin?: string | null;
    csrf?: string | null;
    contentType?: string;
  },
): HeadersInit {
  const email = options?.email ?? "engineer@example.com";
  const sub = options?.sub ?? "user-a";
  const headers: Record<string, string> = {
    cookie: accessSessionCookie(email, { sub }),
    "content-type": options?.contentType ?? "application/json",
  };
  if (options?.origin !== null) {
    headers.origin = options?.origin ?? "https://files.example.com";
  }
  if (options?.csrf !== null) {
    headers["x-r2e-csrf"] = options?.csrf ?? "1";
  }
  return headers;
}

async function initUpload(
  app: ReturnType<typeof createApp>,
  env: Awaited<ReturnType<typeof createTestEnv>>["env"],
  options?: {
    authMode?: "bearer" | "cookie";
    email?: string;
    sub?: string;
    filename?: string;
    prefix?: string;
    declaredSize?: number;
    contentType?: string;
    sha256?: string;
    origin?: string | null;
    csrf?: string | null;
  },
): Promise<Response> {
  return app.fetch(
    new Request("https://files.example.com/api/v2/upload/init", {
      method: "POST",
      headers:
        options?.authMode === "cookie"
          ? uploadCookieHeaders(env, {
              email: options?.email,
              sub: options?.sub,
              origin: options?.origin,
              csrf: options?.csrf,
            })
          : uploadHeaders({
              email: options?.email,
              sub: options?.sub,
              origin: options?.origin,
              csrf: options?.csrf,
            }),
      body: JSON.stringify({
        filename: options?.filename ?? "sample.bin",
        prefix: options?.prefix ?? "uploads/",
        declaredSize: options?.declaredSize ?? 1024,
        contentType: options?.contentType ?? "application/octet-stream",
        ...(options?.sha256 ? { sha256: options.sha256 } : {}),
      }),
    }),
    env,
  );
}

async function parseInitPayload(response: Response): Promise<InitPayload> {
  return (await response.json()) as InitPayload;
}

describe("multipart upload flow", () => {
  useAccessJwksFetchMock();

  it("uploads and completes multipart object via init/sign-part/complete", async () => {
    const { env, bucket } = await createTestEnv();
    const partSize = 5 * 1024 * 1024;
    env.R2E_UPLOAD_PART_SIZE_BYTES = String(partSize);
    const app = createApp();

    const initResponse = await initUpload(app, env, {
      declaredSize: partSize * 2,
      sha256: "a".repeat(64),
    });
    expect(initResponse.status).toBe(200);

    const initPayload = await parseInitPayload(initResponse);
    expect(initPayload.sessionId).toBeTruthy();
    expect(initPayload.uploadId).toBeTruthy();
    expect(initPayload.objectKey.startsWith("uploads/")).toBe(true);

    const upload = bucket.resumeMultipartUpload(
      stagingObjectKey(initPayload.sessionId, initPayload.objectKey),
      initPayload.uploadId,
    );

    const partOneBytes = new Uint8Array(partSize);
    partOneBytes.fill(65);
    const partOneMd5 = md5Base64(partOneBytes);
    const signPartOneResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/sign-part", {
        method: "POST",
        headers: uploadHeaders(),
        body: JSON.stringify({
          sessionId: initPayload.sessionId,
          uploadId: initPayload.uploadId,
          partNumber: 1,
          contentLength: partSize,
          contentMd5: partOneMd5,
        }),
      }),
      env,
    );
    expect(signPartOneResponse.status).toBe(200);
    const signPartOnePayload = (await signPartOneResponse.json()) as {
      url: string;
      headers: Record<string, string>;
    };
    expect(signPartOnePayload.url.includes("uploadId=")).toBe(true);
    expect(signPartOnePayload.headers["content-md5"]).toBe(partOneMd5);
    expect(signPartOnePayload.headers["content-length"]).toBeUndefined();
    const signedHeaderSet = new Set(
      (new URL(signPartOnePayload.url).searchParams.get("X-Amz-SignedHeaders") ?? "").split(";"),
    );
    expect(signedHeaderSet.has("content-length")).toBe(false);
    const uploadedPartOne = await upload.uploadPart(1, partOneBytes);

    const partTwoBytes = new Uint8Array(partSize);
    partTwoBytes.fill(66);
    const partTwoMd5 = md5Base64(partTwoBytes);
    const signPartTwoResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/sign-part", {
        method: "POST",
        headers: uploadHeaders(),
        body: JSON.stringify({
          sessionId: initPayload.sessionId,
          uploadId: initPayload.uploadId,
          partNumber: 2,
          contentLength: partSize,
          contentMd5: partTwoMd5,
        }),
      }),
      env,
    );
    expect(signPartTwoResponse.status).toBe(200);
    const uploadedPartTwo = await upload.uploadPart(2, partTwoBytes);

    const completeResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/complete", {
        method: "POST",
        headers: uploadHeaders(),
        body: JSON.stringify({
          sessionId: initPayload.sessionId,
          uploadId: initPayload.uploadId,
          finalSize: partSize * 2,
          parts: [
            {
              partNumber: 1,
              etag: uploadedPartOne.etag,
            },
            {
              partNumber: 2,
              etag: uploadedPartTwo.etag,
            },
          ],
        }),
      }),
      env,
    );
    expect(completeResponse.status).toBe(200);

    const completePayload = (await completeResponse.json()) as {
      key: string;
      size: number;
      originalFilename: string;
    };
    expect(completePayload.key).toBe(initPayload.objectKey);
    expect(completePayload.size).toBe(partSize * 2);
    expect(completePayload.originalFilename).toBe("sample.bin");

    const downloadResponse = await app.fetch(
      new Request(`https://files.example.com/api/v2/download?key=${encodeURIComponent(initPayload.objectKey)}`, {
        headers: accessHeaders("engineer@example.com", { sub: "user-a" }),
      }),
      env,
    );
    expect(downloadResponse.status).toBe(200);
    const bytes = new Uint8Array(await downloadResponse.arrayBuffer());
    expect(bytes.byteLength).toBe(partSize * 2);
    expect(bytes[0]).toBe(65);
    expect(bytes[partSize - 1]).toBe(65);
    expect(bytes[partSize]).toBe(66);
    expect(bytes[bytes.byteLength - 1]).toBe(66);
  });

  it("returns hard-switched init response fields", async () => {
    const { env } = await createTestEnv();
    const app = createApp();

    const response = await initUpload(app, env, {
      declaredSize: 2048,
    });
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      objectKey: string;
      allowedExt: string[];
      key?: string;
      allowedExtensions?: string[];
    };
    expect(payload.objectKey.length).toBeGreaterThan(0);
    expect(Array.isArray(payload.allowedExt)).toBe(true);
    expect(payload.key).toBeUndefined();
    expect(payload.allowedExtensions).toBeUndefined();
  });

  it("rejects legacy upload part route", async () => {
    const { env } = await createTestEnv();
    const app = createApp();

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/part", {
        method: "POST",
        headers: {
          ...uploadHeaders({ contentType: "application/octet-stream" }),
        },
        body: new TextEncoder().encode("abc"),
      }),
      env,
    );

    expect(response.status).toBe(404);
  });

  it("rejects wrong owner/session/uploadId combinations", async () => {
    const { env } = await createTestEnv();
    const app = createApp();

    const initResponse = await initUpload(app, env, {
      declaredSize: 2048,
      email: "owner-a@example.com",
      sub: "owner-a",
    });
    expect(initResponse.status).toBe(200);
    const initPayload = await parseInitPayload(initResponse);

    const wrongOwnerSign = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/sign-part", {
        method: "POST",
        headers: uploadHeaders({ email: "owner-b@example.com", sub: "owner-b" }),
        body: JSON.stringify({
          sessionId: initPayload.sessionId,
          uploadId: initPayload.uploadId,
          partNumber: 1,
          contentLength: 2048,
        }),
      }),
      env,
    );
    expect(wrongOwnerSign.status).toBe(404);
    expect(((await wrongOwnerSign.json()) as ErrorPayload).error?.code).toBe("upload_session_not_found");

    const wrongSessionSign = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/sign-part", {
        method: "POST",
        headers: uploadHeaders({ email: "owner-a@example.com", sub: "owner-a" }),
        body: JSON.stringify({
          sessionId: "missing-session-id",
          uploadId: initPayload.uploadId,
          partNumber: 1,
          contentLength: 2048,
        }),
      }),
      env,
    );
    expect(wrongSessionSign.status).toBe(404);
    expect(((await wrongSessionSign.json()) as ErrorPayload).error?.code).toBe("upload_session_not_found");

    const wrongUploadSign = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/sign-part", {
        method: "POST",
        headers: uploadHeaders({ email: "owner-a@example.com", sub: "owner-a" }),
        body: JSON.stringify({
          sessionId: initPayload.sessionId,
          uploadId: "wrong-upload-id",
          partNumber: 1,
          contentLength: 2048,
        }),
      }),
      env,
    );
    expect(wrongUploadSign.status).toBe(409);
    expect(((await wrongUploadSign.json()) as ErrorPayload).error?.code).toBe("upload_session_mismatch");

    const wrongUploadComplete = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/complete", {
        method: "POST",
        headers: uploadHeaders({ email: "owner-a@example.com", sub: "owner-a" }),
        body: JSON.stringify({
          sessionId: initPayload.sessionId,
          uploadId: "wrong-upload-id",
          finalSize: 2048,
          parts: [
            {
              partNumber: 1,
              etag: "etag-1",
            },
          ],
        }),
      }),
      env,
    );
    expect(wrongUploadComplete.status).toBe(409);
    expect(((await wrongUploadComplete.json()) as ErrorPayload).error?.code).toBe("upload_session_mismatch");

    const wrongUploadAbort = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/abort", {
        method: "POST",
        headers: uploadHeaders({ email: "owner-a@example.com", sub: "owner-a" }),
        body: JSON.stringify({
          sessionId: initPayload.sessionId,
          uploadId: "wrong-upload-id",
        }),
      }),
      env,
    );
    expect(wrongUploadAbort.status).toBe(409);
    expect(((await wrongUploadAbort.json()) as ErrorPayload).error?.code).toBe("upload_session_mismatch");
  });

  it("rejects duplicate, unsorted, and out-of-range complete parts", async () => {
    const { env, bucket } = await createTestEnv();
    const partSize = 5 * 1024 * 1024;
    env.R2E_UPLOAD_PART_SIZE_BYTES = String(partSize);
    const app = createApp();

    const initResponse = await initUpload(app, env, {
      declaredSize: partSize * 2,
    });
    expect(initResponse.status).toBe(200);
    const initPayload = await parseInitPayload(initResponse);

    const upload = bucket.resumeMultipartUpload(
      stagingObjectKey(initPayload.sessionId, initPayload.objectKey),
      initPayload.uploadId,
    );
    const first = new Uint8Array(partSize);
    first.fill(10);
    const second = new Uint8Array(partSize);
    second.fill(20);
    const uploadedPartOne = await upload.uploadPart(1, first);
    const uploadedPartTwo = await upload.uploadPart(2, second);

    const duplicateResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/complete", {
        method: "POST",
        headers: uploadHeaders(),
        body: JSON.stringify({
          sessionId: initPayload.sessionId,
          uploadId: initPayload.uploadId,
          finalSize: partSize * 2,
          parts: [
            { partNumber: 1, etag: uploadedPartOne.etag },
            { partNumber: 1, etag: uploadedPartOne.etag },
          ],
        }),
      }),
      env,
    );
    expect(duplicateResponse.status).toBe(400);
    expect(((await duplicateResponse.json()) as ErrorPayload).error?.code).toBe("duplicate_part_number");

    const unsortedResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/complete", {
        method: "POST",
        headers: uploadHeaders(),
        body: JSON.stringify({
          sessionId: initPayload.sessionId,
          uploadId: initPayload.uploadId,
          finalSize: partSize * 2,
          parts: [
            { partNumber: 2, etag: uploadedPartTwo.etag },
            { partNumber: 1, etag: uploadedPartOne.etag },
          ],
        }),
      }),
      env,
    );
    expect(unsortedResponse.status).toBe(400);
    expect(((await unsortedResponse.json()) as ErrorPayload).error?.code).toBe("invalid_part_order");

    env.R2E_UPLOAD_MAX_PARTS = "1";
    const outOfRangeInit = await initUpload(app, env, {
      filename: "sample-out-of-range.bin",
      declaredSize: partSize,
    });
    expect(outOfRangeInit.status).toBe(200);
    const outOfRangePayload = await parseInitPayload(outOfRangeInit);

    const outOfRangeResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/complete", {
        method: "POST",
        headers: uploadHeaders(),
        body: JSON.stringify({
          sessionId: outOfRangePayload.sessionId,
          uploadId: outOfRangePayload.uploadId,
          finalSize: partSize,
          parts: [
            { partNumber: 2, etag: uploadedPartTwo.etag },
          ],
        }),
      }),
      env,
    );
    expect(outOfRangeResponse.status).toBe(400);
    expect(((await outOfRangeResponse.json()) as ErrorPayload).error?.code).toBe("invalid_part_number");
  });

  it("handles abort idempotently", async () => {
    const { env } = await createTestEnv();
    const app = createApp();

    const initResponse = await initUpload(app, env, {
      declaredSize: 4096,
    });
    expect(initResponse.status).toBe(200);
    const initPayload = await parseInitPayload(initResponse);

    const firstAbort = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/abort", {
        method: "POST",
        headers: uploadHeaders(),
        body: JSON.stringify({
          sessionId: initPayload.sessionId,
          uploadId: initPayload.uploadId,
        }),
      }),
      env,
    );
    expect(firstAbort.status).toBe(200);

    const secondAbort = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/abort", {
        method: "POST",
        headers: uploadHeaders(),
        body: JSON.stringify({
          sessionId: initPayload.sessionId,
          uploadId: initPayload.uploadId,
        }),
      }),
      env,
    );
    expect(secondAbort.status).toBe(200);
    expect((await secondAbort.json()) as { ok: boolean }).toEqual({ ok: true });
  });

  it("enforces origin and CSRF guards on upload control-plane routes", async () => {
    const { env } = await createTestEnv();
    const app = createApp();

    const missingOrigin = await initUpload(app, env, {
      authMode: "cookie",
      origin: null,
      declaredSize: 2048,
    });
    expect(missingOrigin.status).toBe(403);
    expect(((await missingOrigin.json()) as ErrorPayload).error?.code).toBe("origin_required");

    const disallowedOrigin = await initUpload(app, env, {
      authMode: "cookie",
      origin: "https://evil.example.com",
      declaredSize: 2048,
    });
    expect(disallowedOrigin.status).toBe(403);
    expect(((await disallowedOrigin.json()) as ErrorPayload).error?.code).toBe("origin_not_allowed");

    const nullOriginLiteral = await initUpload(app, env, {
      authMode: "cookie",
      origin: "null",
      declaredSize: 2048,
    });
    expect(nullOriginLiteral.status).toBe(403);
    expect(((await nullOriginLiteral.json()) as ErrorPayload).error?.code).toBe("origin_invalid");

    const malformedOrigin = await initUpload(app, env, {
      authMode: "cookie",
      origin: "://malformed-origin",
      declaredSize: 2048,
    });
    expect(malformedOrigin.status).toBe(403);
    expect(((await malformedOrigin.json()) as ErrorPayload).error?.code).toBe("origin_invalid");

    const javascriptOrigin = await initUpload(app, env, {
      authMode: "cookie",
      origin: "javascript:void(0)",
      declaredSize: 2048,
    });
    expect(javascriptOrigin.status).toBe(403);
    expect(((await javascriptOrigin.json()) as ErrorPayload).error?.code).toBe("origin_invalid");

    const missingCsrf = await initUpload(app, env, {
      authMode: "cookie",
      csrf: null,
      declaredSize: 2048,
    });
    expect(missingCsrf.status).toBe(403);
    expect(((await missingCsrf.json()) as ErrorPayload).error?.code).toBe("csrf_required");

    const nonCanonicalCsrf = await initUpload(app, env, {
      authMode: "cookie",
      csrf: "TRUE",
      declaredSize: 2048,
    });
    expect(nonCanonicalCsrf.status).toBe(403);
    expect(((await nonCanonicalCsrf.json()) as ErrorPayload).error?.code).toBe("csrf_required");
  });

  it("does not require Origin/CSRF for Access-header upload mutation routes", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const response = await initUpload(app, env, {
      authMode: "bearer",
      origin: null,
      csrf: null,
      declaredSize: 1024,
    });
    expect(response.status).toBe(200);
  });

  it("accepts Access service-token principals on upload mutation routes", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    const jwt = createAccessJwt({
      email: null,
      sub: null,
      commonName: "ci-preview-service-token",
    });

    const response = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/init", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://files.example.com",
          "x-r2e-csrf": "1",
          "cf-access-jwt-assertion": jwt,
        },
        body: JSON.stringify({
          filename: "service-token.bin",
          prefix: "uploads/",
          declaredSize: 1024,
          contentType: "application/octet-stream",
        }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      sessionId: string;
      uploadId: string;
      objectKey: string;
    };
    expect(payload.sessionId.length).toBeGreaterThan(0);
    expect(payload.uploadId.length).toBeGreaterThan(0);
    expect(payload.objectKey.startsWith("uploads/")).toBe(true);
  });

  it("enforces configured upload caps and keeps zero defaults unlimited", async () => {
    const { env } = await createTestEnv();
    const app = createApp();

    const serverInfo = await app.fetch(
      new Request("https://files.example.com/api/v2/session/info", {
        headers: accessHeaders("engineer@example.com", { sub: "user-a" }),
      }),
      env,
    );
    expect(serverInfo.status).toBe(200);
    const serverInfoPayload = (await serverInfo.json()) as {
      limits: {
        upload: {
          maxFileBytes: number;
          maxParts: number;
          maxConcurrentPerUser: number;
        };
      };
    };
    expect(serverInfoPayload.limits.upload.maxFileBytes).toBe(0);
    expect(serverInfoPayload.limits.upload.maxParts).toBe(10000);
    expect(serverInfoPayload.limits.upload.maxConcurrentPerUser).toBe(0);

    env.R2E_UPLOAD_MAX_FILE_BYTES = "1024";
    const sizeCapped = await initUpload(app, env, {
      declaredSize: 2048,
    });
    expect(sizeCapped.status).toBe(413);
    expect(((await sizeCapped.json()) as ErrorPayload).error?.code).toBe("upload_size_limit");

    env.R2E_UPLOAD_MAX_FILE_BYTES = "0";
    env.R2E_UPLOAD_MAX_PARTS = "1";
    env.R2E_UPLOAD_PART_SIZE_BYTES = String(5 * 1024 * 1024);
    const partCapped = await initUpload(app, env, {
      declaredSize: 10 * 1024 * 1024,
    });
    expect(partCapped.status).toBe(413);
    expect(((await partCapped.json()) as ErrorPayload).error?.code).toBe("upload_part_limit");

    env.R2E_UPLOAD_MAX_PARTS = "0";
    env.R2E_UPLOAD_MAX_CONCURRENT_PER_USER = "1";
    const first = await initUpload(app, env, {
      sub: "user-cap",
      declaredSize: 1024,
    });
    expect(first.status).toBe(200);
    const second = await initUpload(app, env, {
      sub: "user-cap",
      declaredSize: 1024,
    });
    expect(second.status).toBe(429);
    expect(((await second.json()) as ErrorPayload).error?.code).toBe("upload_concurrency_limit");
  });

  it("fails fast on invalid numeric upload policy values", async () => {
    const { env } = await createTestEnv();
    const app = createApp();

    env.R2E_UPLOAD_MAX_FILE_BYTES = "-1";
    const invalidNonNegative = await initUpload(app, env, {
      declaredSize: 1024,
    });
    expect(invalidNonNegative.status).toBe(500);
    const invalidNonNegativePayload = (await invalidNonNegative.json()) as {
      error?: { code?: string; message?: string };
    };
    expect(invalidNonNegativePayload.error?.code).toBe("upload_config_invalid");
    expect(invalidNonNegativePayload.error?.message).toContain("R2E_UPLOAD_MAX_FILE_BYTES");

    env.R2E_UPLOAD_MAX_FILE_BYTES = "0";
    env.R2E_UPLOAD_SESSION_TTL_SEC = "bad-value";
    const invalidPositive = await initUpload(app, env, {
      declaredSize: 1024,
    });
    expect(invalidPositive.status).toBe(500);
    const invalidPositivePayload = (await invalidPositive.json()) as {
      error?: { code?: string; message?: string };
    };
    expect(invalidPositivePayload.error?.code).toBe("upload_config_invalid");
    expect(invalidPositivePayload.error?.message).toContain("R2E_UPLOAD_SESSION_TTL_SEC");
  });

  it("fails fast when an active session already targets the same object key", async () => {
    const { env } = await createTestEnv();
    const app = createApp();

    const firstInit = await initUpload(app, env, {
      filename: "archive.bin",
      prefix: "uploads/",
      declaredSize: 2048,
    });
    const secondInit = await initUpload(app, env, {
      filename: "archive.bin",
      prefix: "uploads/",
      declaredSize: 2048,
    });
    expect(firstInit.status).toBe(200);

    const firstPayload = await parseInitPayload(firstInit);
    expect(firstPayload.objectKey).toBe("uploads/archive.bin");
    expect(secondInit.status).toBe(409);
    expect(((await secondInit.json()) as ErrorPayload).error?.code).toBe("upload_object_key_in_use");
  });

  it("allows init when target object key already exists to support overwrite flows", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();

    await bucket.put("uploads/archive.bin", new Uint8Array([1, 2, 3]));
    const response = await initUpload(app, env, {
      filename: "archive.bin",
      prefix: "uploads/",
      declaredSize: 2048,
    });

    expect(response.status).toBe(200);
    const payload = await parseInitPayload(response);
    expect(payload.objectKey).toBe("uploads/archive.bin");
  });

  it("preserves empty key segments when signing multipart part URLs", async () => {
    const { env } = await createTestEnv();
    const app = createApp();

    const initResponse = await initUpload(app, env, {
      filename: "sample.bin",
      prefix: "uploads//nested//",
      declaredSize: 1024,
    });
    expect(initResponse.status).toBe(200);
    const initPayload = await parseInitPayload(initResponse);
    expect(initPayload.objectKey.includes("//")).toBe(true);

    const signResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/sign-part", {
        method: "POST",
        headers: uploadHeaders(),
        body: JSON.stringify({
          sessionId: initPayload.sessionId,
          uploadId: initPayload.uploadId,
          partNumber: 1,
          contentLength: 1024,
        }),
      }),
      env,
    );
    expect(signResponse.status).toBe(200);

    const signPayload = (await signResponse.json()) as {
      url: string;
    };
    const signedPath = decodeURIComponent(new URL(signPayload.url).pathname);
    expect(signedPath.endsWith(`/${initPayload.objectKey}`)).toBe(true);
  });

  it("accepts ZIP-container MIME aliases when magic bytes detect ZIP", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();
    const declaredSize = 1024;
    env.R2E_UPLOAD_ALLOWED_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    const initResponse = await initUpload(app, env, {
      filename: "document.docx",
      declaredSize,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(initResponse.status).toBe(200);
    const initPayload = await parseInitPayload(initResponse);

    const partBytes = new Uint8Array(declaredSize);
    partBytes.fill(7);
    partBytes[0] = 0x50;
    partBytes[1] = 0x4b;
    partBytes[2] = 0x03;
    partBytes[3] = 0x04;
    const partMd5 = md5Base64(partBytes);

    const signResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/sign-part", {
        method: "POST",
        headers: uploadHeaders(),
        body: JSON.stringify({
          sessionId: initPayload.sessionId,
          uploadId: initPayload.uploadId,
          partNumber: 1,
          contentLength: declaredSize,
          contentMd5: partMd5,
        }),
      }),
      env,
    );
    expect(signResponse.status).toBe(200);

    const upload = bucket.resumeMultipartUpload(
      stagingObjectKey(initPayload.sessionId, initPayload.objectKey),
      initPayload.uploadId,
    );
    const uploadedPart = await upload.uploadPart(1, partBytes);

    const completeResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/complete", {
        method: "POST",
        headers: uploadHeaders(),
        body: JSON.stringify({
          sessionId: initPayload.sessionId,
          uploadId: initPayload.uploadId,
          finalSize: declaredSize,
          parts: [
            {
              partNumber: 1,
              etag: uploadedPart.etag,
            },
          ],
        }),
      }),
      env,
    );

    expect(completeResponse.status).toBe(200);
  });

  it("blocks ZIP magic when detected MIME is blocked even if OOXML declared MIME is allowlisted", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();
    const declaredSize = 1024;
    env.R2E_UPLOAD_ALLOWED_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    env.R2E_UPLOAD_BLOCKED_MIME = "application/zip";

    const initResponse = await initUpload(app, env, {
      filename: "document.docx",
      declaredSize,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(initResponse.status).toBe(200);
    const initPayload = await parseInitPayload(initResponse);

    const partBytes = new Uint8Array(declaredSize);
    partBytes.fill(7);
    partBytes[0] = 0x50;
    partBytes[1] = 0x4b;
    partBytes[2] = 0x03;
    partBytes[3] = 0x04;
    const partMd5 = md5Base64(partBytes);

    const signResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/sign-part", {
        method: "POST",
        headers: uploadHeaders(),
        body: JSON.stringify({
          sessionId: initPayload.sessionId,
          uploadId: initPayload.uploadId,
          partNumber: 1,
          contentLength: declaredSize,
          contentMd5: partMd5,
        }),
      }),
      env,
    );
    expect(signResponse.status).toBe(200);

    const upload = bucket.resumeMultipartUpload(
      stagingObjectKey(initPayload.sessionId, initPayload.objectKey),
      initPayload.uploadId,
    );
    const uploadedPart = await upload.uploadPart(1, partBytes);

    const completeResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/complete", {
        method: "POST",
        headers: uploadHeaders(),
        body: JSON.stringify({
          sessionId: initPayload.sessionId,
          uploadId: initPayload.uploadId,
          finalSize: declaredSize,
          parts: [
            {
              partNumber: 1,
              etag: uploadedPart.etag,
            },
          ],
        }),
      }),
      env,
    );

    expect(completeResponse.status).toBe(400);
    const payload = (await completeResponse.json()) as ErrorPayload;
    expect(payload.error?.code).toBe("upload_magic_blocked");
  });

  it("does not allow declared application/zip when only OOXML MIME is allowlisted", async () => {
    const { env } = await createTestEnv();
    const app = createApp();
    env.R2E_UPLOAD_ALLOWED_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    const initResponse = await initUpload(app, env, {
      filename: "archive.zip",
      declaredSize: 1024,
      contentType: "application/zip",
    });

    expect(initResponse.status).toBe(400);
    const payload = (await initResponse.json()) as ErrorPayload;
    expect(payload.error?.code).toBe("upload_content_type_not_allowed");
  });

  it("blocks blacklisted extensions even when allowlist is unset", async () => {
    const { env } = await createTestEnv();
    env.R2E_UPLOAD_BLOCKED_EXT = ".exe,.dll";
    const app = createApp();

    const response = await initUpload(app, env, {
      filename: "dangerous.exe",
      declaredSize: 1024,
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as ErrorPayload;
    expect(payload.error?.code).toBe("upload_extension_blocked");
  });

  it("blocks blacklisted MIME types even when allowlist is unset", async () => {
    const { env } = await createTestEnv();
    env.R2E_UPLOAD_BLOCKED_MIME = "application/octet-stream,application/x-msdownload";
    const app = createApp();

    const response = await initUpload(app, env, {
      filename: "payload.bin",
      declaredSize: 1024,
      contentType: "application/octet-stream",
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as ErrorPayload;
    expect(payload.error?.code).toBe("upload_content_type_blocked");
  });

  it("preserves the pre-existing object when an overwrite fails magic-byte validation", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();
    const declaredSize = 1024;

    await bucket.put("uploads/report.pdf", "original pdf content", {
      httpMetadata: { contentType: "application/pdf" },
    });

    const initResponse = await initUpload(app, env, {
      filename: "report.pdf",
      prefix: "uploads/",
      declaredSize,
      contentType: "application/pdf",
    });
    expect(initResponse.status).toBe(200);
    const initPayload = await parseInitPayload(initResponse);
    expect(initPayload.objectKey).toBe("uploads/report.pdf");
    const stagingKey = stagingObjectKey(initPayload.sessionId, initPayload.objectKey);

    // PNG magic bytes disagree with the declared application/pdf type.
    const partBytes = new Uint8Array(declaredSize);
    partBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const upload = bucket.resumeMultipartUpload(stagingKey, initPayload.uploadId);
    const uploadedPart = await upload.uploadPart(1, partBytes);

    const completeResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/complete", {
        method: "POST",
        headers: uploadHeaders(),
        body: JSON.stringify({
          sessionId: initPayload.sessionId,
          uploadId: initPayload.uploadId,
          finalSize: declaredSize,
          parts: [{ partNumber: 1, etag: uploadedPart.etag }],
        }),
      }),
      env,
    );
    expect(completeResponse.status).toBe(400);
    expect(((await completeResponse.json()) as ErrorPayload).error?.code).toBe("upload_magic_mismatch");

    // The original object survives the rejected overwrite and the staged
    // upload is cleaned up.
    const original = await bucket.get("uploads/report.pdf");
    expect(await original?.text()).toBe("original pdf content");
    expect(await bucket.get(stagingKey)).toBeNull();
  });

  it("promotes a valid overwrite from staging onto the target key", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();
    const declaredSize = 1024;

    await bucket.put("uploads/replace.pdf", "old pdf");

    const initResponse = await initUpload(app, env, {
      filename: "replace.pdf",
      prefix: "uploads/",
      declaredSize,
      contentType: "application/pdf",
    });
    expect(initResponse.status).toBe(200);
    const initPayload = await parseInitPayload(initResponse);
    const stagingKey = stagingObjectKey(initPayload.sessionId, initPayload.objectKey);

    const partBytes = new Uint8Array(declaredSize);
    partBytes.set([0x25, 0x50, 0x44, 0x46], 0);
    const upload = bucket.resumeMultipartUpload(stagingKey, initPayload.uploadId);
    const uploadedPart = await upload.uploadPart(1, partBytes);

    const completeResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/complete", {
        method: "POST",
        headers: uploadHeaders(),
        body: JSON.stringify({
          sessionId: initPayload.sessionId,
          uploadId: initPayload.uploadId,
          finalSize: declaredSize,
          parts: [{ partNumber: 1, etag: uploadedPart.etag }],
        }),
      }),
      env,
    );
    expect(completeResponse.status).toBe(200);
    const completePayload = (await completeResponse.json()) as { key: string; size: number };
    expect(completePayload.key).toBe("uploads/replace.pdf");
    expect(completePayload.size).toBe(declaredSize);

    const replaced = await bucket.get("uploads/replace.pdf");
    const replacedBytes = new Uint8Array((await replaced?.arrayBuffer()) ?? new ArrayBuffer(0));
    expect(replacedBytes.byteLength).toBe(declaredSize);
    expect(replacedBytes[0]).toBe(0x25);
    expect(await bucket.get(stagingKey)).toBeNull();
  });

  it("rejects completed uploads whose size does not match declaredSize", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();

    const initResponse = await initUpload(app, env, {
      filename: "short.bin",
      prefix: "uploads/",
      declaredSize: 1024,
    });
    expect(initResponse.status).toBe(200);
    const initPayload = await parseInitPayload(initResponse);
    const stagingKey = stagingObjectKey(initPayload.sessionId, initPayload.objectKey);

    const partBytes = new Uint8Array(512);
    partBytes.fill(9);
    const upload = bucket.resumeMultipartUpload(stagingKey, initPayload.uploadId);
    const uploadedPart = await upload.uploadPart(1, partBytes);

    const completeResponse = await app.fetch(
      new Request("https://files.example.com/api/v2/upload/complete", {
        method: "POST",
        headers: uploadHeaders(),
        body: JSON.stringify({
          sessionId: initPayload.sessionId,
          uploadId: initPayload.uploadId,
          parts: [{ partNumber: 1, etag: uploadedPart.etag }],
        }),
      }),
      env,
    );
    expect(completeResponse.status).toBe(400);
    expect(((await completeResponse.json()) as ErrorPayload).error?.code).toBe("upload_size_mismatch");

    // Neither the target key nor the staged object remains.
    expect(await bucket.get("uploads/short.bin")).toBeNull();
    expect(await bucket.get(stagingKey)).toBeNull();
  });

  it("rejects upload prefixes outside the configured allowlist", async () => {
    const { env } = await createTestEnv();
    env.R2E_UPLOAD_PREFIX_ALLOWLIST = "public/";
    const app = createApp();

    const response = await initUpload(app, env, {
      prefix: "private/",
      declaredSize: 1024,
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as ErrorPayload).error?.code).toBe("upload_prefix_forbidden");
  });

  it("rejects traversal and separator-bearing upload filenames", async () => {
    const { env } = await createTestEnv();
    const app = createApp();

    const dotDot = await initUpload(app, env, {
      filename: "..",
      declaredSize: 1024,
    });
    expect(dotDot.status).toBe(400);
    expect(((await dotDot.json()) as ErrorPayload).error?.code).toBe("invalid_upload_filename");

    const separator = await initUpload(app, env, {
      filename: "nested/evil.bin",
      declaredSize: 1024,
    });
    expect(separator.status).toBe(400);
    expect(((await separator.json()) as ErrorPayload).error?.code).toBe("invalid_upload_filename");

    const traversalPrefix = await initUpload(app, env, {
      prefix: "uploads/../secrets/",
      declaredSize: 1024,
    });
    expect(traversalPrefix.status).toBe(400);
    expect(((await traversalPrefix.json()) as ErrorPayload).error?.code).toBe("invalid_upload_prefix");
  });

  it("rejects uploads targeting the reserved staging prefix", async () => {
    const { env } = await createTestEnv();
    const app = createApp();

    const response = await initUpload(app, env, {
      prefix: ".r2e-staging/hijack/",
      declaredSize: 1024,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorPayload).error?.code).toBe("invalid_upload_prefix");
  });

  it("omits the configured origin allowlist from origin_not_allowed errors", async () => {
    const { env } = await createTestEnv();
    const app = createApp();

    const response = await initUpload(app, env, {
      authMode: "cookie",
      origin: "https://evil.example.com",
      declaredSize: 1024,
    });
    expect(response.status).toBe(403);
    const payload = (await response.json()) as {
      error?: { code?: string; details?: { origin?: string; allowedOrigins?: unknown } };
    };
    expect(payload.error?.code).toBe("origin_not_allowed");
    expect(payload.error?.details?.origin).toBe("https://evil.example.com");
    expect(payload.error?.details?.allowedOrigins).toBeUndefined();
  });
});

describe("promoteObject", () => {
  const smallLimits = { singlePutLimitBytes: 8, copyPartSizeBytes: 4 };

  function trackDirectPuts(bucket: MemoryR2Bucket): string[] {
    const directPutKeys: string[] = [];
    const originalPut = bucket.put.bind(bucket);
    bucket.put = async (key, value, options) => {
      directPutKeys.push(key);
      return originalPut(key, value, options);
    };
    return directPutKeys;
  }

  it("promotes a staged object larger than the single-put limit via multipart copy", async () => {
    const bucket = new MemoryR2Bucket();
    const payload = Uint8Array.from({ length: 21 }, (_, index) => index);
    await bucket.put(".r2e-staging/session/big.bin", payload, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { source: "staged" },
    });
    const directPutKeys = trackDirectPuts(bucket);

    const stored = await promoteObject(
      bucket as unknown as R2Bucket,
      ".r2e-staging/session/big.bin",
      "docs/big.bin",
      smallLimits,
    );

    // The staged bytes must not funnel through one size-capped put() call.
    expect(directPutKeys).not.toContain("docs/big.bin");
    expect(stored.size).toBe(payload.byteLength);
    const target = await bucket.get("docs/big.bin");
    expect(target).not.toBeNull();
    expect(new Uint8Array(await target!.arrayBuffer())).toEqual(payload);
    expect(target?.httpMetadata?.contentType).toBe("application/octet-stream");
    expect(target?.customMetadata).toEqual({ source: "staged" });
    expect(await bucket.get(".r2e-staging/session/big.bin")).toBeNull();
  });

  it("keeps the single-put fast path for objects within the limit", async () => {
    const bucket = new MemoryR2Bucket();
    const payload = Uint8Array.from({ length: 6 }, (_, index) => index);
    await bucket.put(".r2e-staging/session/small.bin", payload, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    const directPutKeys = trackDirectPuts(bucket);

    await promoteObject(
      bucket as unknown as R2Bucket,
      ".r2e-staging/session/small.bin",
      "docs/small.bin",
      smallLimits,
    );

    expect(directPutKeys).toEqual(["docs/small.bin"]);
    const target = await bucket.get("docs/small.bin");
    expect(new Uint8Array(await target!.arrayBuffer())).toEqual(payload);
    expect(await bucket.get(".r2e-staging/session/small.bin")).toBeNull();
  });
});
