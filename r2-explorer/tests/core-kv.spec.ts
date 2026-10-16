import { describe, expect, it, vi } from "vitest";
import { getShareRecord, listSharesForObject, putShareRecord, shareIndexKey, shareRecordKey } from "../src/kv";
import type { ShareRecord } from "../src/types";
import { createTestEnv } from "./helpers/memory";

function makeRecord(overrides: Partial<ShareRecord> = {}): ShareRecord {
  return {
    tokenId: "tok-valid",
    bucket: "files",
    key: "docs/report.txt",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    maxDownloads: 0,
    downloadCount: 0,
    revoked: false,
    createdBy: "ops@example.com",
    contentDisposition: "attachment",
    ...overrides,
  };
}

describe("listSharesForObject", () => {
  it("skips one corrupted share record and still returns the valid ones", async () => {
    const { env } = await createTestEnv();
    const valid = makeRecord({ tokenId: "tok-valid" });
    await putShareRecord(env.R2E_SHARES_KV, valid, 3600);

    // A syntactically-valid-JSON-but-wrong-shape record under the same
    // object's index prefix, simulating KV corruption or a schema drift.
    const badTokenId = "tok-bad";
    await env.R2E_SHARES_KV.put(shareIndexKey(valid.bucket, valid.key, badTokenId), "", { expirationTtl: 3600 });
    await env.R2E_SHARES_KV.put(shareRecordKey(badTokenId), JSON.stringify({ tokenId: badTokenId }), {
      expirationTtl: 3600,
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await listSharesForObject(env.R2E_SHARES_KV, valid.bucket, valid.key);
      expect(result.shares.map((share) => share.tokenId)).toEqual([valid.tokenId]);
      expect(errorSpy).toHaveBeenCalled();
      expect(errorSpy.mock.calls.some((call) => call.join(" ").includes(badTokenId))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("putShareRecord", () => {
  it("writes the index entry before the primary record", async () => {
    const { env } = await createTestEnv();
    const record = makeRecord({ tokenId: "tok-order" });
    const originalPut = env.R2E_SHARES_KV.put.bind(env.R2E_SHARES_KV);
    const calls: string[] = [];
    const putSpy = vi
      .spyOn(env.R2E_SHARES_KV, "put")
      .mockImplementation(async (key: string, value: string, options?: { expirationTtl?: number }) => {
        calls.push(key);
        return originalPut(key, value, options);
      });

    try {
      await putShareRecord(env.R2E_SHARES_KV, record, 3600);
      expect(calls).toEqual([
        shareIndexKey(record.bucket, record.key, record.tokenId),
        shareRecordKey(record.tokenId),
      ]);
    } finally {
      putSpy.mockRestore();
    }
  });

  it("leaves no redeemable primary record when the second write fails", async () => {
    const { env } = await createTestEnv();
    const record = makeRecord({ tokenId: "tok-partial" });
    const originalPut = env.R2E_SHARES_KV.put.bind(env.R2E_SHARES_KV);
    let callCount = 0;
    const putSpy = vi
      .spyOn(env.R2E_SHARES_KV, "put")
      .mockImplementation(async (key: string, value: string, options?: { expirationTtl?: number }) => {
        callCount += 1;
        if (callCount === 2) {
          throw new Error("transient KV failure");
        }
        return originalPut(key, value, options);
      });

    try {
      await expect(putShareRecord(env.R2E_SHARES_KV, record, 3600)).rejects.toThrow("transient KV failure");
      // Only a phantom index entry exists; the share is not redeemable.
      expect(await getShareRecord(env.R2E_SHARES_KV, record.tokenId)).toBeNull();
    } finally {
      putSpy.mockRestore();
    }
  });
});
