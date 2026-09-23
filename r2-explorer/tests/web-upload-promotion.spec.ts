import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, isAbortError } from "../web/src/lib/api";
import { isCancelledDuringPromotion, multipartUpload, type UploadProgress } from "../web/src/lib/upload";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

/** Body shape the upload-sessions Durable Object sends while a lease is held (see acquire-promotion-lease). */
function promotionError(retryAfterSeconds: number): unknown {
  return {
    error: {
      code: "upload_promotion_in_progress",
      message: "Another request is already promoting this upload.",
      details: { retryAfterSeconds },
    },
  };
}

function testFile(): File {
  return new File([new Uint8Array([1, 2, 3, 4])], "archive.bin", { type: "application/octet-stream" });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("web upload: complete's upload_promotion_in_progress handling", () => {
  it("waits out two promotion-in-progress responses then resolves, without ever calling abort", async () => {
    vi.useFakeTimers();
    let completeAttempts = 0;
    let abortCalled = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");

      if (url.endsWith("/api/v2/upload/init") && method === "POST") {
        return jsonResponse({
          sessionId: "session-1",
          objectKey: "uploads/archive.bin",
          uploadId: "upload-1",
          expiresAt: "2099-01-01T00:00:00.000Z",
          partSizeBytes: 16,
          maxParts: 10000,
          signPartTtlSec: 60,
          allowedMime: [],
          allowedExt: [],
        });
      }

      if (url.endsWith("/api/v2/upload/sign-part") && method === "POST") {
        return jsonResponse({
          sessionId: "session-1",
          uploadId: "upload-1",
          partNumber: 1,
          url: "https://upload.example.test/part-1",
          method: "PUT",
          headers: {},
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      }

      if (url === "https://upload.example.test/part-1" && method === "PUT") {
        return new Response(null, { status: 200, headers: { etag: '"etag-1"' } });
      }

      if (url.endsWith("/api/v2/upload/complete") && method === "POST") {
        completeAttempts += 1;
        if (completeAttempts <= 2) {
          return jsonResponse(promotionError(1), 409);
        }
        return jsonResponse({ key: "uploads/archive.bin" });
      }

      if (url.endsWith("/api/v2/upload/abort") && method === "POST") {
        abortCalled = true;
        return jsonResponse({ ok: true });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const uploadPromise = multipartUpload(testFile(), "uploads/");
    await vi.runAllTimersAsync();
    const completed = await uploadPromise;

    expect(completed.key).toBe("uploads/archive.bin");
    expect(completeAttempts).toBe(3);
    expect(abortCalled).toBe(false);
  });

  it("clamps the promotion wait to [1s, 30s] regardless of the server's advertised retryAfterSeconds", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    let completeAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");

      if (url.endsWith("/api/v2/upload/init") && method === "POST") {
        return jsonResponse({
          sessionId: "session-1",
          objectKey: "uploads/archive.bin",
          uploadId: "upload-1",
          expiresAt: "2099-01-01T00:00:00.000Z",
          partSizeBytes: 16,
          maxParts: 10000,
          signPartTtlSec: 60,
          allowedMime: [],
          allowedExt: [],
        });
      }

      if (url.endsWith("/api/v2/upload/sign-part") && method === "POST") {
        return jsonResponse({
          sessionId: "session-1",
          uploadId: "upload-1",
          partNumber: 1,
          url: "https://upload.example.test/part-1",
          method: "PUT",
          headers: {},
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      }

      if (url === "https://upload.example.test/part-1" && method === "PUT") {
        return new Response(null, { status: 200, headers: { etag: '"etag-1"' } });
      }

      if (url.endsWith("/api/v2/upload/complete") && method === "POST") {
        completeAttempts += 1;
        // First wait: server asks for far longer than the sane cap.
        if (completeAttempts === 1) {
          return jsonResponse(promotionError(120), 409);
        }
        // Second wait: server asks for less than the sane floor.
        if (completeAttempts === 2) {
          return jsonResponse(promotionError(0), 409);
        }
        return jsonResponse({ key: "uploads/archive.bin" });
      }

      if (url.endsWith("/api/v2/upload/abort") && method === "POST") {
        return jsonResponse({ ok: true });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const uploadPromise = multipartUpload(testFile(), "uploads/");
    await vi.runAllTimersAsync();
    const completed = await uploadPromise;

    expect(completed.key).toBe("uploads/archive.bin");
    expect(completeAttempts).toBe(3);
    const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(delays).toContain(30000);
    expect(delays).toContain(1000);
    expect(delays).not.toContain(120000);
  });

  it("fails with a finalizing message and never calls abort once the promotion wait bound is exhausted", async () => {
    vi.useFakeTimers();
    let completeAttempts = 0;
    let abortCalled = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");

      if (url.endsWith("/api/v2/upload/init") && method === "POST") {
        return jsonResponse({
          sessionId: "session-1",
          objectKey: "uploads/archive.bin",
          uploadId: "upload-1",
          expiresAt: "2099-01-01T00:00:00.000Z",
          partSizeBytes: 16,
          maxParts: 10000,
          signPartTtlSec: 60,
          allowedMime: [],
          allowedExt: [],
        });
      }

      if (url.endsWith("/api/v2/upload/sign-part") && method === "POST") {
        return jsonResponse({
          sessionId: "session-1",
          uploadId: "upload-1",
          partNumber: 1,
          url: "https://upload.example.test/part-1",
          method: "PUT",
          headers: {},
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      }

      if (url === "https://upload.example.test/part-1" && method === "PUT") {
        return new Response(null, { status: 200, headers: { etag: '"etag-1"' } });
      }

      if (url.endsWith("/api/v2/upload/complete") && method === "POST") {
        completeAttempts += 1;
        // The lease never clears: every complete keeps hitting the same 409.
        return jsonResponse(promotionError(30), 409);
      }

      if (url.endsWith("/api/v2/upload/abort") && method === "POST") {
        abortCalled = true;
        return jsonResponse({ ok: true });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const uploadPromise = multipartUpload(testFile(), "uploads/");
    // Attached before the clock moves: the rejection happens mid-timer-drain
    // below, and attaching .catch() only afterward races Node's unhandled-
    // rejection check against that drain (PromiseRejectionHandledWarning).
    const errorPromise = uploadPromise.catch((caught: unknown) => caught);
    await vi.runAllTimersAsync();
    const error = await errorPromise;

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.code).toBe("upload_promotion_in_progress");
    expect(apiError.message).toMatch(/still finalizing/i);
    expect(apiError.message).toMatch(/may appear shortly/i);
    expect(abortCalled).toBe(false);
    // 20-minute bound over a 30s-clamped wait: many attempts, but finite.
    expect(completeAttempts).toBeGreaterThan(1);
  });

  it("rejects promptly with a distinct error when cancelled during the promotion wait, and never calls abort", async () => {
    vi.useFakeTimers();
    let completeAttempts = 0;
    let abortCalled = false;
    let resolveWaiting: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      resolveWaiting = resolve;
    });
    const controller = new AbortController();

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");

      if (url.endsWith("/api/v2/upload/init") && method === "POST") {
        return jsonResponse({
          sessionId: "session-1",
          objectKey: "uploads/archive.bin",
          uploadId: "upload-1",
          expiresAt: "2099-01-01T00:00:00.000Z",
          partSizeBytes: 16,
          maxParts: 10000,
          signPartTtlSec: 60,
          allowedMime: [],
          allowedExt: [],
        });
      }

      if (url.endsWith("/api/v2/upload/sign-part") && method === "POST") {
        return jsonResponse({
          sessionId: "session-1",
          uploadId: "upload-1",
          partNumber: 1,
          url: "https://upload.example.test/part-1",
          method: "PUT",
          headers: {},
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      }

      if (url === "https://upload.example.test/part-1" && method === "PUT") {
        return new Response(null, { status: 200, headers: { etag: '"etag-1"' } });
      }

      if (url.endsWith("/api/v2/upload/complete") && method === "POST") {
        completeAttempts += 1;
        return jsonResponse(promotionError(30), 409);
      }

      if (url.endsWith("/api/v2/upload/abort") && method === "POST") {
        abortCalled = true;
        return jsonResponse({ ok: true });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const uploadPromise = multipartUpload(testFile(), "uploads/", {
      signal: controller.signal,
      // Fires synchronously right before the wait's sleep() call is made, so
      // awaiting it lands the abort() below exactly inside the wait, without
      // guessing a microtask-tick count or advancing the fake clock.
      onProgress: (progress: UploadProgress) => {
        if (progress.phase === "finalizing") {
          resolveWaiting();
        }
      },
    });
    const settled = uploadPromise.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    await waiting;
    controller.abort();
    const result = await settled;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Not a plain AbortError: the caller must be able to tell the user that
      // the server may still finish this upload.
      expect(isAbortError(result.error)).toBe(false);
      expect(isCancelledDuringPromotion(result.error)).toBe(true);
    }
    // Settled without ever advancing the fake clock: the cancel did not wait
    // out the remaining delay, it rejected as soon as the signal fired.
    expect(completeAttempts).toBe(1);
    // The worker refuses abort with the same 409 while its promotion lease is
    // held, so the engine must not even try.
    expect(abortCalled).toBe(false);
  });

  it("does not treat an unrelated 409 (object_exists) on complete as a promotion wait", async () => {
    let completeAttempts = 0;
    let abortCalled = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");

      if (url.endsWith("/api/v2/upload/init") && method === "POST") {
        return jsonResponse({
          sessionId: "session-1",
          objectKey: "uploads/archive.bin",
          uploadId: "upload-1",
          expiresAt: "2099-01-01T00:00:00.000Z",
          partSizeBytes: 16,
          maxParts: 10000,
          signPartTtlSec: 60,
          allowedMime: [],
          allowedExt: [],
        });
      }

      if (url.endsWith("/api/v2/upload/sign-part") && method === "POST") {
        return jsonResponse({
          sessionId: "session-1",
          uploadId: "upload-1",
          partNumber: 1,
          url: "https://upload.example.test/part-1",
          method: "PUT",
          headers: {},
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      }

      if (url === "https://upload.example.test/part-1" && method === "PUT") {
        return new Response(null, { status: 200, headers: { etag: '"etag-1"' } });
      }

      if (url.endsWith("/api/v2/upload/complete") && method === "POST") {
        completeAttempts += 1;
        return jsonResponse(
          {
            error: {
              code: "object_exists",
              message: "An object already exists at the target key.",
              details: { key: "uploads/archive.bin" },
            },
          },
          409,
        );
      }

      if (url.endsWith("/api/v2/upload/abort") && method === "POST") {
        abortCalled = true;
        return jsonResponse({ ok: true });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await multipartUpload(testFile(), "uploads/").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(409);
    expect(apiError.code).toBe("object_exists");
    // No promotion-wait loop entered: exactly one complete call, immediate abort.
    expect(completeAttempts).toBe(1);
    expect(abortCalled).toBe(true);
  });
});
