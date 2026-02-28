import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createShare, fetchSessionInfo, multipartUpload } from "../web/src/lib/api";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("web api retry behavior", () => {
  it("retries transient session info failures with exponential backoff", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "temporary_failure",
              message: "please retry",
            },
          },
          503,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "temporary_failure",
              message: "please retry",
            },
          },
          503,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          version: "test-version",
          readonly: false,
          actor: { mode: "access", actor: "ops@example.com" },
          limits: {
            uiMaxListLimit: 200,
            upload: {
              maxFileBytes: 0,
              maxParts: 10000,
              maxConcurrentPerUser: 0,
              sessionTtlSec: 3600,
              signPartTtlSec: 60,
              partSizeBytes: 8388608,
              allowedMime: [],
              blockedMime: [],
              allowedExtensions: [],
              blockedExtensions: [],
              prefixAllowlist: [],
            },
          },
          buckets: [{ alias: "files", binding: "FILES_BUCKET" }],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const responsePromise = fetchSessionInfo();
    await vi.runAllTimersAsync();
    const payload = await responsePromise;

    expect(payload.version).toBe("test-version");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-idempotent createShare mutations", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "temporary_failure",
              message: "try later",
            },
          },
          503,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(createShare("docs/a.txt", "1h", 1)).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries transient signed-part upload failures and completes upload", async () => {
    vi.useFakeTimers();
    let partUploadAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
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
        partUploadAttempts += 1;
        if (partUploadAttempts === 1) {
          return new Response("temporary edge failure", { status: 503 });
        }
        return new Response(null, {
          status: 200,
          headers: {
            etag: "\"etag-1\"",
          },
        });
      }

      if (url.endsWith("/api/v2/upload/complete") && method === "POST") {
        return jsonResponse({
          key: "uploads/archive.bin",
        });
      }

      if (url.endsWith("/api/v2/upload/abort") && method === "POST") {
        return jsonResponse({ ok: true });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const file = new File([new Uint8Array([1, 2, 3, 4])], "archive.bin", {
      type: "application/octet-stream",
    });

    const uploadPromise = multipartUpload(file, "uploads/");
    await vi.runAllTimersAsync();
    const completed = await uploadPromise;

    expect(completed.key).toBe("uploads/archive.bin");
    expect(partUploadAttempts).toBe(2);
  });
});
