import { describe, expect, it } from "vitest";
import { ApiError, type SessionInfoResponse } from "../web/src/lib/api";
import {
  buildAcceptAttribute,
  errorMessage,
  focusableRow,
  isAuthRequired,
  isListingEmpty,
  isObjectExistsError,
  normalizeShareTtl,
  objectExistsKey,
  parseMaxDownloads,
  prefixLabel,
  resolveListLimit,
} from "../web/src/lib/format";

describe("isAuthRequired", () => {
  it("treats token_invalid_signature as auth-required", () => {
    expect(isAuthRequired(new ApiError(401, "token_invalid_signature", "sig check failed"))).toBe(true);
  });

  it("matches access_required and token_invalid", () => {
    expect(isAuthRequired(new ApiError(401, "access_required", "sign in"))).toBe(true);
    expect(isAuthRequired(new ApiError(401, "token_invalid", "bad jwt"))).toBe(true);
  });

  it("rejects non-401 statuses and unrelated codes", () => {
    expect(isAuthRequired(new ApiError(403, "token_invalid", "bad jwt"))).toBe(false);
    expect(isAuthRequired(new ApiError(401, "share_not_found", "missing"))).toBe(false);
    expect(isAuthRequired(new Error("not an api error"))).toBe(false);
  });
});

describe("isObjectExistsError / objectExistsKey", () => {
  it("matches a 409 object_exists ApiError and extracts details.key", () => {
    const error = new ApiError(409, "object_exists", "conflict", { key: "uploads/a.txt" });
    expect(isObjectExistsError(error)).toBe(true);
    expect(objectExistsKey(error)).toBe("uploads/a.txt");
  });

  it("rejects other statuses/codes and missing/malformed details", () => {
    expect(isObjectExistsError(new ApiError(409, "share_not_found", "x"))).toBe(false);
    expect(isObjectExistsError(new ApiError(400, "object_exists", "x"))).toBe(false);
    expect(isObjectExistsError(new Error("nope"))).toBe(false);
    expect(objectExistsKey(new ApiError(409, "object_exists", "x"))).toBeNull();
    expect(objectExistsKey(new ApiError(409, "object_exists", "x", { key: 5 }))).toBeNull();
  });
});

describe("errorMessage", () => {
  it("surfaces the first validation issue instead of the generic boilerplate", () => {
    const error = new ApiError(400, "validation_error", "Invalid request body.", {
      issues: [{ path: ["declaredSize"], message: "declaredSize must be a positive number" }],
    });
    expect(errorMessage(error)).toBe("declaredSize: declaredSize must be a positive number (validation_error)");
  });

  it("falls back to the generic message when details.issues is absent or empty", () => {
    expect(errorMessage(new ApiError(400, "validation_error", "Invalid request body."))).toBe(
      "Invalid request body. (validation_error)",
    );
    expect(errorMessage(new ApiError(400, "validation_error", "Invalid request body.", { issues: [] }))).toBe(
      "Invalid request body. (validation_error)",
    );
  });

  it("displays a server upload_empty_file message as is", () => {
    expect(errorMessage(new ApiError(400, "upload_empty_file", "Cannot upload an empty file."))).toBe(
      "Cannot upload an empty file. (upload_empty_file)",
    );
  });
});

describe("prefixLabel", () => {
  it("returns the trailing segment of a nested delimited prefix", () => {
    expect(prefixLabel("workspace/incident-logs/2026-01-05-postmortem/")).toBe("2026-01-05-postmortem");
  });

  it("returns a top-level prefix unchanged (minus the trailing slash)", () => {
    expect(prefixLabel("workspace/")).toBe("workspace");
  });
});

describe("normalizeShareTtl", () => {
  it("rejects a bare number, asking for a unit", () => {
    const result = normalizeShareTtl("5");
    expect(result.ok).toBe(false);
  });

  it("accepts <number><unit> and passes it through unchanged", () => {
    expect(normalizeShareTtl("24h")).toEqual({ ok: true, value: "24h" });
    expect(normalizeShareTtl(" 7d ")).toEqual({ ok: true, value: "7d" });
  });

  it("defaults an empty value to 24h, matching the server default", () => {
    expect(normalizeShareTtl("")).toEqual({ ok: true, value: "24h" });
    expect(normalizeShareTtl("   ")).toEqual({ ok: true, value: "24h" });
  });
});

describe("parseMaxDownloads", () => {
  it("parses a valid non-negative integer, where 0 means unlimited", () => {
    expect(parseMaxDownloads("5")).toEqual({ ok: true, value: 5 });
    expect(parseMaxDownloads("0")).toEqual({ ok: true, value: 0 });
  });

  it("defaults a blank value to 1", () => {
    expect(parseMaxDownloads("")).toEqual({ ok: true, value: 1 });
    expect(parseMaxDownloads("   ")).toEqual({ ok: true, value: 1 });
  });

  it("rejects anything parseInt would silently coerce to 0, instead of widening the share", () => {
    expect(parseMaxDownloads("abc").ok).toBe(false);
    expect(parseMaxDownloads("-3").ok).toBe(false);
    expect(parseMaxDownloads("0.5").ok).toBe(false);
    expect(parseMaxDownloads("0abc").ok).toBe(false);
    expect(parseMaxDownloads("0x10").ok).toBe(false);
  });

  it("rejects a trailing non-digit rather than truncating it silently", () => {
    expect(parseMaxDownloads("10x").ok).toBe(false);
  });
});

function sessionWithListLimit(limit: number): SessionInfoResponse {
  return {
    version: "test",
    readonly: false,
    actor: { mode: "access", actor: "ops@example.com" },
    limits: {
      uiMaxListLimit: limit,
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
  };
}

describe("resolveListLimit", () => {
  it("uses session.limits.uiMaxListLimit when present", () => {
    expect(resolveListLimit(sessionWithListLimit(500))).toBe(500);
  });

  it("falls back to 200 when session is absent", () => {
    expect(resolveListLimit(null)).toBe(200);
  });
});

describe("isListingEmpty", () => {
  it("is never empty while loading", () => {
    expect(isListingEmpty(true, 0, 0)).toBe(false);
  });

  it("is empty only once loading is finished and both counts are zero", () => {
    expect(isListingEmpty(false, 0, 0)).toBe(true);
    expect(isListingEmpty(false, 1, 0)).toBe(false);
    expect(isListingEmpty(false, 0, 1)).toBe(false);
  });
});

describe("focusableRow", () => {
  it("picks the selected object over any folder", () => {
    expect(focusableRow(["a/"], ["x", "y"], "y")).toEqual({ kind: "object", value: "y" });
  });

  it("falls back to the first folder when nothing is selected and folders exist", () => {
    expect(focusableRow(["a/", "b/"], ["x"], null)).toEqual({ kind: "folder", value: "a/" });
  });

  it("falls back to the first object when there are no folders and nothing selected", () => {
    expect(focusableRow([], ["x", "y"], null)).toEqual({ kind: "object", value: "x" });
  });

  it("returns null for an empty listing", () => {
    expect(focusableRow([], [], null)).toBeNull();
  });

  it("ignores a stale selectedKey that is no longer listed", () => {
    expect(focusableRow(["a/"], ["x"], "stale-key")).toEqual({ kind: "folder", value: "a/" });
  });
});

describe("buildAcceptAttribute", () => {
  it("joins extensions (dotted) and MIME types into one accept value", () => {
    expect(buildAcceptAttribute([".png", "jpg"], ["image/png"])).toBe(".png,.jpg,image/png");
  });

  it("returns an empty string when both lists are empty", () => {
    expect(buildAcceptAttribute([], [])).toBe("");
  });
});
