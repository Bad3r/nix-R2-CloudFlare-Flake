import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { completeMultipartUpload, promoteObject } from "../src/r2";
import { stagingObjectKey } from "../src/routes/upload";
import { acquirePromotionLease, releasePromotionLease } from "../src/upload-sessions";
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
    overwrite?: boolean;
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
        ...(options?.overwrite !== undefined ? { overwrite: options.overwrite } : {}),
      }),
    }),
    env,
  );
}

/** POST /api/v2/upload/complete with the given headers and JSON body. */
async function completeUpload(
  app: ReturnType<typeof createApp>,
  env: Awaited<ReturnType<typeof createTestEnv>>["env"],
  body: Record<string, unknown>,
): Promise<Response> {
  return app.fetch(
    new Request("https://files.example.com/api/v2/upload/complete", {
      method: "POST",
      headers: uploadHeaders(),
      body: JSON.stringify(body),
    }),
    env,
  );
}

/** POST /api/v2/upload/abort with the given headers and JSON body. */
async function abortUpload(
  app: ReturnType<typeof createApp>,
  env: Awaited<ReturnType<typeof createTestEnv>>["env"],
  body: Record<string, unknown>,
): Promise<Response> {
  return app.fetch(
    new Request("https://files.example.com/api/v2/upload/abort", {
      method: "POST",
      headers: uploadHeaders(),
      body: JSON.stringify(body),
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

  it("rejects init when target object key already exists and overwrite is not requested", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();

    await bucket.put("uploads/archive.bin", new Uint8Array([1, 2, 3]));
    const response = await initUpload(app, env, {
      filename: "archive.bin",
      prefix: "uploads/",
      declaredSize: 2048,
    });

    expect(response.status).toBe(409);
    const payload = (await response.json()) as { error?: { code?: string; details?: { key?: string } } };
    expect(payload.error?.code).toBe("object_exists");
    expect(payload.error?.details?.key).toBe("uploads/archive.bin");
  });

  it("allows init when target object key already exists and overwrite is true", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();

    await bucket.put("uploads/archive.bin", new Uint8Array([1, 2, 3]));
    const response = await initUpload(app, env, {
      filename: "archive.bin",
      prefix: "uploads/",
      declaredSize: 2048,
      overwrite: true,
    });

    expect(response.status).toBe(200);
    const payload = await parseInitPayload(response);
    expect(payload.objectKey).toBe("uploads/archive.bin");
    // The pre-existing object is untouched until a valid overwrite completes.
    const original = await bucket.get("uploads/archive.bin");
    expect(new Uint8Array((await original?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(new Uint8Array([1, 2, 3]));
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
      overwrite: true,
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

  it("surfaces the validation error even when staged cleanup delete fails", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();
    const declaredSize = 1024;

    const initResponse = await initUpload(app, env, {
      filename: "report.pdf",
      prefix: "uploads/",
      declaredSize,
      contentType: "application/pdf",
    });
    expect(initResponse.status).toBe(200);
    const initPayload = await parseInitPayload(initResponse);
    const stagingKey = stagingObjectKey(initPayload.sessionId, initPayload.objectKey);

    // PNG magic bytes disagree with the declared application/pdf type, so the
    // completion is rejected and the staged object is deleted.
    const partBytes = new Uint8Array(declaredSize);
    partBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const upload = bucket.resumeMultipartUpload(stagingKey, initPayload.uploadId);
    const uploadedPart = await upload.uploadPart(1, partBytes);

    // A transient delete failure during cleanup must not mask the 400
    // validation error with a 500.
    const deleteSpy = vi
      .spyOn(bucket, "delete")
      .mockRejectedValue(new Error("transient R2 delete failure"));

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

    expect(deleteSpy).toHaveBeenCalledWith(stagingKey);
    expect(completeResponse.status).toBe(400);
    expect(((await completeResponse.json()) as ErrorPayload).error?.code).toBe("upload_magic_mismatch");

    deleteSpy.mockRestore();
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
      overwrite: true,
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

  it("omits the configured origin value from upload_config_invalid errors", async () => {
    const { env } = await createTestEnv();
    env.R2E_UPLOAD_ALLOWED_ORIGINS = "ht!tp://boguslisted-origin";
    const app = createApp();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await initUpload(app, env, {
        authMode: "cookie",
        declaredSize: 1024,
      });
      expect(response.status).toBe(500);
      const bodyText = await response.text();
      const payload = JSON.parse(bodyText) as ErrorPayload;
      expect(payload.error?.code).toBe("upload_config_invalid");
      // The configured entry is logged for the operator, never echoed.
      expect(bodyText).not.toContain("boguslisted-origin");
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("upload completion resilience (UPS-001, UPS-005)", () => {
  useAccessJwksFetchMock();

  it("resumes and completes on retry after a promotion failure, without redoing assembly", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();
    const declaredSize = 1024;

    const initResponse = await initUpload(app, env, {
      filename: "resume.bin",
      prefix: "uploads/",
      declaredSize,
    });
    expect(initResponse.status).toBe(200);
    const initPayload = await parseInitPayload(initResponse);
    const stagingKey = stagingObjectKey(initPayload.sessionId, initPayload.objectKey);

    const partBytes = new Uint8Array(declaredSize).fill(42);
    const upload = bucket.resumeMultipartUpload(stagingKey, initPayload.uploadId);
    const uploadedPart = await upload.uploadPart(1, partBytes);

    const completeBody = {
      sessionId: initPayload.sessionId,
      uploadId: initPayload.uploadId,
      finalSize: declaredSize,
      parts: [{ partNumber: 1, etag: uploadedPart.etag }],
    };

    const putSpy = vi.spyOn(bucket, "put").mockImplementationOnce(() => {
      throw new Error("simulated promotion failure");
    });
    const firstComplete = await completeUpload(app, env, completeBody);
    expect(firstComplete.status).toBe(500);
    const firstPayload = (await firstComplete.json()) as ErrorPayload;
    expect(firstPayload.error?.code).toBe("upload_promotion_failed");
    putSpy.mockRestore();

    // The staged object must survive the failed promotion; nothing is at the
    // final key yet, and completeMultipartUpload is not re-run on retry
    // (the uploadId was already consumed, so resuming it would throw).
    expect(await bucket.get(stagingKey)).not.toBeNull();
    expect(await bucket.get("uploads/resume.bin")).toBeNull();

    const secondComplete = await completeUpload(app, env, completeBody);
    expect(secondComplete.status).toBe(200);
    const secondPayload = (await secondComplete.json()) as { key: string; size: number };
    expect(secondPayload.key).toBe("uploads/resume.bin");
    expect(secondPayload.size).toBe(declaredSize);
    expect(await bucket.get(stagingKey)).toBeNull();
  });

  it("aborts cleanly after a promotion failure, deleting the staged object", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();
    const declaredSize = 1024;

    const initResponse = await initUpload(app, env, {
      filename: "resume-abort.bin",
      prefix: "uploads/",
      declaredSize,
    });
    const initPayload = await parseInitPayload(initResponse);
    const stagingKey = stagingObjectKey(initPayload.sessionId, initPayload.objectKey);

    const partBytes = new Uint8Array(declaredSize).fill(7);
    const upload = bucket.resumeMultipartUpload(stagingKey, initPayload.uploadId);
    const uploadedPart = await upload.uploadPart(1, partBytes);

    const putSpy = vi.spyOn(bucket, "put").mockImplementationOnce(() => {
      throw new Error("simulated promotion failure");
    });
    const failedComplete = await completeUpload(app, env, {
      sessionId: initPayload.sessionId,
      uploadId: initPayload.uploadId,
      finalSize: declaredSize,
      parts: [{ partNumber: 1, etag: uploadedPart.etag }],
    });
    expect(failedComplete.status).toBe(500);
    putSpy.mockRestore();

    const abortResponse = await abortUpload(app, env, {
      sessionId: initPayload.sessionId,
      uploadId: initPayload.uploadId,
    });
    expect(abortResponse.status).toBe(200);
    expect(await bucket.get(stagingKey)).toBeNull();

    const secondAbort = await abortUpload(app, env, {
      sessionId: initPayload.sessionId,
      uploadId: initPayload.uploadId,
    });
    expect(secondAbort.status).toBe(200);
    expect((await secondAbort.json()) as { ok: boolean }).toEqual({ ok: true });
  });

  it("returns the original success payload when complete is retried after a full success", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();
    const declaredSize = 1024;

    const initResponse = await initUpload(app, env, {
      filename: "twice.bin",
      prefix: "uploads/",
      declaredSize,
    });
    const initPayload = await parseInitPayload(initResponse);
    const stagingKey = stagingObjectKey(initPayload.sessionId, initPayload.objectKey);

    const partBytes = new Uint8Array(declaredSize).fill(5);
    const upload = bucket.resumeMultipartUpload(stagingKey, initPayload.uploadId);
    const uploadedPart = await upload.uploadPart(1, partBytes);

    const body = {
      sessionId: initPayload.sessionId,
      uploadId: initPayload.uploadId,
      finalSize: declaredSize,
      parts: [{ partNumber: 1, etag: uploadedPart.etag }],
    };
    const firstComplete = await completeUpload(app, env, body);
    expect(firstComplete.status).toBe(200);
    const firstPayload = await firstComplete.json();

    const secondComplete = await completeUpload(app, env, body);
    expect(secondComplete.status).toBe(200);
    const secondPayload = await secondComplete.json();
    expect(secondPayload).toEqual(firstPayload);
  });

  it("aborts a session whose multipart upload no longer exists, logging the cause", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();

    const initResponse = await initUpload(app, env, {
      filename: "gone.bin",
      prefix: "uploads/",
      declaredSize: 1024,
    });
    const initPayload = await parseInitPayload(initResponse);
    const stagingKey = stagingObjectKey(initPayload.sessionId, initPayload.objectKey);

    // Simulate the underlying R2 multipart upload having vanished
    // independently of the session (already finalized, or expired on R2's
    // own schedule).
    await bucket.resumeMultipartUpload(stagingKey, initPayload.uploadId).abort();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const abortResponse = await abortUpload(app, env, {
        sessionId: initPayload.sessionId,
        uploadId: initPayload.uploadId,
      });
      expect(abortResponse.status).toBe(200);
      expect((await abortResponse.json()) as { ok: boolean }).toEqual({ ok: true });
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("resumes after completeMultipartUpload throws for an active session whose assembly already finished", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();
    const declaredSize = 1024;

    const initResponse = await initUpload(app, env, {
      filename: "crash-window.bin",
      prefix: "uploads/",
      declaredSize,
    });
    const initPayload = await parseInitPayload(initResponse);
    const stagingKey = stagingObjectKey(initPayload.sessionId, initPayload.objectKey);

    const partBytes = new Uint8Array(declaredSize).fill(3);
    const upload = bucket.resumeMultipartUpload(stagingKey, initPayload.uploadId);
    const uploadedPart = await upload.uploadPart(1, partBytes);

    // Simulate the crash window: R2 already finalized the multipart upload
    // (the staged object exists at the declared size) but the session is
    // still "active" because the request that ran completeMultipartUpload
    // never got to record anything afterward. A duplicate/retried complete
    // now calls completeMultipartUpload again against the dead uploadId.
    await completeMultipartUpload(bucket, stagingKey, initPayload.uploadId, [
      { partNumber: 1, etag: uploadedPart.etag },
    ]);

    const completeResponse = await completeUpload(app, env, {
      sessionId: initPayload.sessionId,
      uploadId: initPayload.uploadId,
      finalSize: declaredSize,
      parts: [{ partNumber: 1, etag: uploadedPart.etag }],
    });
    expect(completeResponse.status).toBe(200);
    const payload = (await completeResponse.json()) as { key: string; size: number };
    expect(payload.key).toBe("uploads/crash-window.bin");
    expect(payload.size).toBe(declaredSize);
  });

  it("fails with a specific code, not internal_error, when completeMultipartUpload throws and no staged object exists", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();
    const declaredSize = 1024;

    const initResponse = await initUpload(app, env, {
      filename: "crash-no-stage.bin",
      prefix: "uploads/",
      declaredSize,
    });
    const initPayload = await parseInitPayload(initResponse);
    const stagingKey = stagingObjectKey(initPayload.sessionId, initPayload.objectKey);

    // Abort the R2-side multipart upload out of band, so completeMultipartUpload
    // throws and, unlike the crash-window case above, no staged object exists
    // to resume from: this is a genuine failure, not a resumable one.
    await bucket.resumeMultipartUpload(stagingKey, initPayload.uploadId).abort();

    const completeResponse = await completeUpload(app, env, {
      sessionId: initPayload.sessionId,
      uploadId: initPayload.uploadId,
      finalSize: declaredSize,
      parts: [{ partNumber: 1, etag: "does-not-matter" }],
    });
    expect(completeResponse.status).toBe(500);
    const payload = (await completeResponse.json()) as ErrorPayload;
    expect(payload.error?.code).toBe("upload_completion_failed");
    expect(payload.error?.code).not.toBe("internal_error");
  });

  it("rejects a second concurrent complete while the first still holds the promotion lease, without touching the final key or trash", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();
    const declaredSize = 1024;

    await bucket.put("uploads/race.bin", "original content");

    const initResponse = await initUpload(app, env, {
      filename: "race.bin",
      prefix: "uploads/",
      declaredSize,
      overwrite: true,
    });
    const initPayload = await parseInitPayload(initResponse);
    const stagingKey = stagingObjectKey(initPayload.sessionId, initPayload.objectKey);

    const partBytes = new Uint8Array(declaredSize).fill(11);
    const upload = bucket.resumeMultipartUpload(stagingKey, initPayload.uploadId);
    const uploadedPart = await upload.uploadPart(1, partBytes);

    // Simulate request A: assembly finished and it already holds the
    // promotion lease, mid-promotion, from request B's point of view.
    await completeMultipartUpload(bucket, stagingKey, initPayload.uploadId, [
      { partNumber: 1, etag: uploadedPart.etag },
    ]);
    await acquirePromotionLease(env, "engineer@example.com", {
      sessionId: initPayload.sessionId,
      uploadId: initPayload.uploadId,
    });

    // Request B: a duplicate/retried complete for the same session, arriving
    // while request A is still promoting.
    const secondComplete = await completeUpload(app, env, {
      sessionId: initPayload.sessionId,
      uploadId: initPayload.uploadId,
      finalSize: declaredSize,
      overwrite: true,
      parts: [{ partNumber: 1, etag: uploadedPart.etag }],
    });
    expect(secondComplete.status).toBe(409);
    const payload = (await secondComplete.json()) as {
      error?: { code?: string; details?: { retryAfterSeconds?: number } };
    };
    expect(payload.error?.code).toBe("upload_promotion_in_progress");
    expect(payload.error?.details?.retryAfterSeconds).toBeGreaterThan(0);

    // Request B touched neither the final key nor .trash/: no soft delete,
    // no promotion, ran for this rejected attempt.
    const finalObject = await bucket.get("uploads/race.bin");
    expect(await finalObject?.text()).toBe("original content");
    const trashed = await bucket.list({ prefix: ".trash/" });
    expect(trashed.objects.length).toBe(0);
  });

  it("refuses abort while the promotion lease is live, and the staged object survives", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();
    const declaredSize = 1024;

    const initResponse = await initUpload(app, env, {
      filename: "abort-race.bin",
      prefix: "uploads/",
      declaredSize,
    });
    const initPayload = await parseInitPayload(initResponse);
    const stagingKey = stagingObjectKey(initPayload.sessionId, initPayload.objectKey);

    const partBytes = new Uint8Array(declaredSize).fill(21);
    const upload = bucket.resumeMultipartUpload(stagingKey, initPayload.uploadId);
    const uploadedPart = await upload.uploadPart(1, partBytes);

    // Simulate request A: assembly finished and it holds the promotion
    // lease, mid-promotion, when request B calls abort instead of retrying
    // complete (for example after its connection dropped and it treated a
    // 409 upload_promotion_in_progress from complete as a failure).
    await completeMultipartUpload(bucket, stagingKey, initPayload.uploadId, [
      { partNumber: 1, etag: uploadedPart.etag },
    ]);
    await acquirePromotionLease(env, "engineer@example.com", {
      sessionId: initPayload.sessionId,
      uploadId: initPayload.uploadId,
    });

    const abortResponse = await abortUpload(app, env, {
      sessionId: initPayload.sessionId,
      uploadId: initPayload.uploadId,
    });
    expect(abortResponse.status).toBe(409);
    const payload = (await abortResponse.json()) as {
      error?: { code?: string; details?: { retryAfterSeconds?: number } };
    };
    expect(payload.error?.code).toBe("upload_promotion_in_progress");
    expect(payload.error?.details?.retryAfterSeconds).toBeGreaterThan(0);

    // The staged object survives: abort touched neither R2 nor the session.
    expect(await bucket.get(stagingKey)).not.toBeNull();

    // Once the lease is released (or expires), abort works normally.
    await releasePromotionLease(env, "engineer@example.com", {
      sessionId: initPayload.sessionId,
      uploadId: initPayload.uploadId,
    });
    const secondAbort = await abortUpload(app, env, {
      sessionId: initPayload.sessionId,
      uploadId: initPayload.uploadId,
    });
    expect(secondAbort.status).toBe(200);
    expect(await bucket.get(stagingKey)).toBeNull();
  });
});

describe("upload overwrite contract (WEB-001)", () => {
  useAccessJwksFetchMock();

  it("rejects a complete-time overwrite conflict before assembly, then succeeds and trashes the old object on retry", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();
    const declaredSize = 1024;

    const initResponse = await initUpload(app, env, {
      filename: "conflict.bin",
      prefix: "uploads/",
      declaredSize,
    });
    expect(initResponse.status).toBe(200);
    const initPayload = await parseInitPayload(initResponse);
    const stagingKey = stagingObjectKey(initPayload.sessionId, initPayload.objectKey);

    // A separate write lands at the target key after init but before complete.
    await bucket.put("uploads/conflict.bin", "raced content");

    const partBytes = new Uint8Array(declaredSize).fill(3);
    const upload = bucket.resumeMultipartUpload(stagingKey, initPayload.uploadId);
    const uploadedPart = await upload.uploadPart(1, partBytes);

    const conflictResponse = await completeUpload(app, env, {
      sessionId: initPayload.sessionId,
      uploadId: initPayload.uploadId,
      finalSize: declaredSize,
      parts: [{ partNumber: 1, etag: uploadedPart.etag }],
    });
    expect(conflictResponse.status).toBe(409);
    const conflictPayload = (await conflictResponse.json()) as {
      error?: { code?: string; details?: { key?: string } };
    };
    expect(conflictPayload.error?.code).toBe("object_exists");
    expect(conflictPayload.error?.details?.key).toBe("uploads/conflict.bin");

    // The multipart upload is untouched: completeMultipartUpload never ran.
    const stillResumable = bucket.resumeMultipartUpload(stagingKey, initPayload.uploadId);
    expect(stillResumable.uploadId).toBe(initPayload.uploadId);

    const retryResponse = await completeUpload(app, env, {
      sessionId: initPayload.sessionId,
      uploadId: initPayload.uploadId,
      finalSize: declaredSize,
      overwrite: true,
      parts: [{ partNumber: 1, etag: uploadedPart.etag }],
    });
    expect(retryResponse.status).toBe(200);

    const finalObject = await bucket.get("uploads/conflict.bin");
    const finalBytes = new Uint8Array((await finalObject?.arrayBuffer()) ?? new ArrayBuffer(0));
    expect(finalBytes.every((byte) => byte === 3)).toBe(true);

    const trashed = await bucket.list({ prefix: ".trash/" });
    const trashedEntry = trashed.objects.find((object) => object.key.endsWith("uploads/conflict.bin"));
    expect(trashedEntry).toBeDefined();
    expect(await (await bucket.get(trashedEntry!.key))?.text()).toBe("raced content");
  });

  it("completes an overwrite requested at init time and moves the old object to .trash/", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();
    const declaredSize = 1024;

    await bucket.put("uploads/replace-init.bin", "old content");

    const initResponse = await initUpload(app, env, {
      filename: "replace-init.bin",
      prefix: "uploads/",
      declaredSize,
      overwrite: true,
    });
    expect(initResponse.status).toBe(200);
    const initPayload = await parseInitPayload(initResponse);
    const stagingKey = stagingObjectKey(initPayload.sessionId, initPayload.objectKey);

    const partBytes = new Uint8Array(declaredSize).fill(9);
    const upload = bucket.resumeMultipartUpload(stagingKey, initPayload.uploadId);
    const uploadedPart = await upload.uploadPart(1, partBytes);

    const completeResponse = await completeUpload(app, env, {
      sessionId: initPayload.sessionId,
      uploadId: initPayload.uploadId,
      finalSize: declaredSize,
      parts: [{ partNumber: 1, etag: uploadedPart.etag }],
    });
    expect(completeResponse.status).toBe(200);

    const finalObject = await bucket.get("uploads/replace-init.bin");
    const finalBytes = new Uint8Array((await finalObject?.arrayBuffer()) ?? new ArrayBuffer(0));
    expect(finalBytes.every((byte) => byte === 9)).toBe(true);

    const trashed = await bucket.list({ prefix: ".trash/" });
    const trashedEntry = trashed.objects.find((object) => object.key.endsWith("uploads/replace-init.bin"));
    expect(trashedEntry).toBeDefined();
    expect(await (await bucket.get(trashedEntry!.key))?.text()).toBe("old content");
  });
});

describe("upload magic-mime carve-out (UPS-004)", () => {
  useAccessJwksFetchMock();

  it("accepts a generic octet-stream declaration when magic bytes detect a known type", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();
    const declaredSize = 1024;

    const initResponse = await initUpload(app, env, {
      filename: "photo.bin",
      prefix: "uploads/",
      declaredSize,
      contentType: "application/octet-stream",
    });
    expect(initResponse.status).toBe(200);
    const initPayload = await parseInitPayload(initResponse);
    const stagingKey = stagingObjectKey(initPayload.sessionId, initPayload.objectKey);

    const partBytes = new Uint8Array(declaredSize);
    partBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const upload = bucket.resumeMultipartUpload(stagingKey, initPayload.uploadId);
    const uploadedPart = await upload.uploadPart(1, partBytes);

    const completeBody = {
      sessionId: initPayload.sessionId,
      uploadId: initPayload.uploadId,
      finalSize: declaredSize,
      parts: [{ partNumber: 1, etag: uploadedPart.etag }],
    };
    const completeResponse = await completeUpload(app, env, completeBody);
    expect(completeResponse.status).toBe(200);
    const payload = (await completeResponse.json()) as { contentType: string | null };
    expect(payload.contentType).toBe("image/png");

    // The promoted object itself must carry the detected type, not the
    // generic placeholder it was staged with, so downloads and previews
    // serve it correctly.
    const finalObject = await bucket.get("uploads/photo.bin");
    expect(finalObject?.httpMetadata?.contentType).toBe("image/png");

    // An idempotent replay must report the same content type as the first
    // response (read from the stored object, not the stale session value).
    const replayResponse = await completeUpload(app, env, completeBody);
    expect(replayResponse.status).toBe(200);
    const replayPayload = await replayResponse.json();
    expect(replayPayload).toEqual(payload);
  });

  it("does not override a real declared Content-Type with the detected type", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();
    const declaredSize = 1024;

    const initResponse = await initUpload(app, env, {
      filename: "report.pdf",
      prefix: "uploads/",
      declaredSize,
      contentType: "application/pdf",
    });
    const initPayload = await parseInitPayload(initResponse);
    const stagingKey = stagingObjectKey(initPayload.sessionId, initPayload.objectKey);

    const partBytes = new Uint8Array(declaredSize);
    partBytes.set([0x25, 0x50, 0x44, 0x46], 0);
    const upload = bucket.resumeMultipartUpload(stagingKey, initPayload.uploadId);
    const uploadedPart = await upload.uploadPart(1, partBytes);

    const completeResponse = await completeUpload(app, env, {
      sessionId: initPayload.sessionId,
      uploadId: initPayload.uploadId,
      finalSize: declaredSize,
      parts: [{ partNumber: 1, etag: uploadedPart.etag }],
    });
    expect(completeResponse.status).toBe(200);
    const finalObject = await bucket.get("uploads/report.pdf");
    expect(finalObject?.httpMetadata?.contentType).toBe("application/pdf");
  });
});

describe("upload policy validation (UPS-007, UPS-009)", () => {
  useAccessJwksFetchMock();

  it("fails fast when the sign TTL is too low for the configured part size", async () => {
    const { env } = await createTestEnv();
    env.R2E_UPLOAD_PART_SIZE_BYTES = String(5 * 1024 * 1024 * 1024);
    env.R2E_UPLOAD_SIGN_TTL_SEC = "60";
    const app = createApp();

    const response = await initUpload(app, env, { declaredSize: 1024 });
    expect(response.status).toBe(500);
    const payload = (await response.json()) as { error?: { code?: string; message?: string } };
    expect(payload.error?.code).toBe("upload_config_invalid");
    expect(payload.error?.message).toContain("R2E_UPLOAD_SIGN_TTL_SEC");
    expect(payload.error?.message).toContain("R2E_UPLOAD_PART_SIZE_BYTES");
  });

  it("rejects declaredSize: 0 with a specific empty-file error", async () => {
    const { env } = await createTestEnv();
    const app = createApp();

    const response = await initUpload(app, env, { declaredSize: 0 });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe("upload_empty_file");
  });
});

describe("upload overwrite promotion resilience (RW-1, RW-3, RW-4)", () => {
  useAccessJwksFetchMock();

  it("leaves the original object at the target key when overwrite promotion fails, and a retry then succeeds leaving redundant trash backups", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();
    const declaredSize = 1024;

    await bucket.put("uploads/overwrite-fail.bin", "original content");

    const initResponse = await initUpload(app, env, {
      filename: "overwrite-fail.bin",
      prefix: "uploads/",
      declaredSize,
      overwrite: true,
    });
    const initPayload = await parseInitPayload(initResponse);
    const stagingKey = stagingObjectKey(initPayload.sessionId, initPayload.objectKey);

    const partBytes = new Uint8Array(declaredSize).fill(77);
    const upload = bucket.resumeMultipartUpload(stagingKey, initPayload.uploadId);
    const uploadedPart = await upload.uploadPart(1, partBytes);

    const completeBody = {
      sessionId: initPayload.sessionId,
      uploadId: initPayload.uploadId,
      finalSize: declaredSize,
      parts: [{ partNumber: 1, etag: uploadedPart.etag }],
    };

    // The backup (copy to .trash/) must still succeed; only promotion's own
    // write to the target key fails, so the put spy is keyed on that exact
    // key rather than failing whichever put happens to run first.
    const originalPut = bucket.put.bind(bucket);
    const putSpy = vi.spyOn(bucket, "put").mockImplementation(async (key, value, options) => {
      if (key === "uploads/overwrite-fail.bin") {
        throw new Error("simulated promotion failure");
      }
      return originalPut(key, value, options);
    });
    const firstComplete = await completeUpload(app, env, completeBody);
    expect(firstComplete.status).toBe(500);
    putSpy.mockRestore();

    // The target key still holds the ORIGINAL object: backing up never
    // deletes it, and promoteObject's failed write never replaced it.
    expect(await (await bucket.get("uploads/overwrite-fail.bin"))?.text()).toBe("original content");
    // The staged upload is untouched and retryable.
    expect(await bucket.get(stagingKey)).not.toBeNull();
    const trashedAfterFailure = await bucket.list({ prefix: ".trash/" });
    expect(trashedAfterFailure.objects.filter((object) => object.key.endsWith("uploads/overwrite-fail.bin")).length).toBe(
      1,
    );

    // Retry: assembly is not redone (staged), so this re-runs the same
    // existence-check-then-backup-then-promote sequence. The original is
    // still there (unpromoted), so the retry backs it up again before
    // promoting: a retry after a promotion failure can leave more than one
    // trash copy of the same original content. Each copy is an independent,
    // harmless duplicate (all recoverable), not a correctness problem, since
    // backing up never deletes and the target key is only ever written by a
    // successful promotion. The trash key embeds a millisecond timestamp, so
    // a short delay here keeps the two attempts' keys from colliding into
    // one, which would otherwise make this assertion flaky, not wrong.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondComplete = await completeUpload(app, env, completeBody);
    expect(secondComplete.status).toBe(200);

    const finalObject = await bucket.get("uploads/overwrite-fail.bin");
    const finalBytes = new Uint8Array((await finalObject?.arrayBuffer()) ?? new ArrayBuffer(0));
    expect(finalBytes.every((byte) => byte === 77)).toBe(true);
    expect(await bucket.get(stagingKey)).toBeNull();

    const trashedAfterRetry = await bucket.list({ prefix: ".trash/" });
    const originalCopies = trashedAfterRetry.objects.filter((object) =>
      object.key.endsWith("uploads/overwrite-fail.bin"),
    );
    expect(originalCopies.length).toBe(2);
    for (const copy of originalCopies) {
      expect(await (await bucket.get(copy.key))?.text()).toBe("original content");
    }
  });

  it("fails with a specific code, not internal_error, when the promotion existence check throws", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();
    const declaredSize = 1024;

    const initResponse = await initUpload(app, env, {
      filename: "precheck-fail.bin",
      prefix: "uploads/",
      declaredSize,
      overwrite: true,
    });
    const initPayload = await parseInitPayload(initResponse);
    const stagingKey = stagingObjectKey(initPayload.sessionId, initPayload.objectKey);

    const partBytes = new Uint8Array(declaredSize).fill(5);
    const upload = bucket.resumeMultipartUpload(stagingKey, initPayload.uploadId);
    const uploadedPart = await upload.uploadPart(1, partBytes);

    // overwrite: true skips the pre-assembly gate's own headObject call, so
    // this is the only bucket.head call in the request: the promotion
    // sequence's own existence check.
    const headSpy = vi.spyOn(bucket, "head").mockImplementationOnce(() => {
      throw new Error("simulated transient R2 failure");
    });
    try {
      const response = await completeUpload(app, env, {
        sessionId: initPayload.sessionId,
        uploadId: initPayload.uploadId,
        finalSize: declaredSize,
        parts: [{ partNumber: 1, etag: uploadedPart.etag }],
      });
      expect(response.status).toBe(500);
      const payload = (await response.json()) as ErrorPayload;
      expect(payload.error?.code).toBe("upload_promotion_precheck_failed");
      expect(payload.error?.code).not.toBe("internal_error");
    } finally {
      headSpy.mockRestore();
    }
  });

  it("closes the check-then-act race for a non-overwrite promotion: a key that appears after the check yields 409 and leaves the concurrent write intact", async () => {
    const { env, bucket } = await createTestEnv();
    const app = createApp();
    const declaredSize = 1024;

    const initResponse = await initUpload(app, env, {
      filename: "race-promote.bin",
      prefix: "uploads/",
      declaredSize,
    });
    const initPayload = await parseInitPayload(initResponse);
    const stagingKey = stagingObjectKey(initPayload.sessionId, initPayload.objectKey);

    const partBytes = new Uint8Array(declaredSize).fill(9);
    const upload = bucket.resumeMultipartUpload(stagingKey, initPayload.uploadId);
    const uploadedPart = await upload.uploadPart(1, partBytes);

    // Without overwrite there are two head(objectKey) calls: the
    // pre-assembly gate (before completeMultipartUpload) and the promotion
    // sequence's own check. Only the second is where RW-3's race lives: a
    // key appearing between that check and promoteObject's own write.
    const originalHead = bucket.head.bind(bucket);
    let headCallCount = 0;
    const headSpy = vi.spyOn(bucket, "head").mockImplementation(async (key: string) => {
      headCallCount += 1;
      if (headCallCount === 2) {
        await bucket.put("uploads/race-promote.bin", "concurrently written content");
        return null;
      }
      return originalHead(key);
    });

    try {
      const response = await completeUpload(app, env, {
        sessionId: initPayload.sessionId,
        uploadId: initPayload.uploadId,
        finalSize: declaredSize,
        parts: [{ partNumber: 1, etag: uploadedPart.etag }],
      });
      expect(response.status).toBe(409);
      const payload = (await response.json()) as { error?: { code?: string; details?: { key?: string } } };
      expect(payload.error?.code).toBe("object_exists");
      expect(payload.error?.details?.key).toBe("uploads/race-promote.bin");

      const destination = await bucket.get("uploads/race-promote.bin");
      expect(await destination?.text()).toBe("concurrently written content");
    } finally {
      headSpy.mockRestore();
    }
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
