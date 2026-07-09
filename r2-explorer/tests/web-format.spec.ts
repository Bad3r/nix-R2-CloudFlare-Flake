import { describe, expect, it } from "vitest";
import { ApiError } from "../web/src/lib/api";
import { isAuthRequired } from "../web/src/lib/format";

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
