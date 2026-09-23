import { describe, expect, it } from "vitest";
import { moveObject, softDeleteObject } from "../src/r2";
import { MemoryR2Bucket } from "./helpers/memory";

// Mirrors the smallLimits override in tests/multipart.spec.ts's promoteObject
// suite, so an object "larger" than the single-put limit can be exercised
// without allocating anything close to R2's real ~5 GiB single-put ceiling.
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

describe("softDeleteObject size-aware copy", () => {
  it("moves an object larger than the single-put limit to trash via multipart copy", async () => {
    const bucket = new MemoryR2Bucket();
    const payload = Uint8Array.from({ length: 21 }, (_, index) => index);
    await bucket.put("docs/big.bin", payload, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { source: "original" },
    });
    const directPutKeys = trackDirectPuts(bucket);

    const result = await softDeleteObject(bucket as unknown as R2Bucket, "docs/big.bin", smallLimits);

    // The oversized object must not funnel through a single size-capped put().
    expect(directPutKeys).not.toContain(result.trashKey);
    const trashed = await bucket.get(result.trashKey);
    expect(trashed).not.toBeNull();
    expect(new Uint8Array(await trashed!.arrayBuffer())).toEqual(payload);
    expect(trashed?.customMetadata).toEqual({ source: "original" });
    expect(await bucket.get("docs/big.bin")).toBeNull();
  });

  it("keeps the single-put fast path for objects within the limit", async () => {
    const bucket = new MemoryR2Bucket();
    await bucket.put("docs/small.bin", "small");
    const directPutKeys = trackDirectPuts(bucket);

    const result = await softDeleteObject(bucket as unknown as R2Bucket, "docs/small.bin", smallLimits);

    expect(directPutKeys).toEqual([result.trashKey]);
    expect(await bucket.get("docs/small.bin")).toBeNull();
  });
});

describe("moveObject size-aware copy", () => {
  it("moves an object larger than the single-put limit via multipart copy", async () => {
    const bucket = new MemoryR2Bucket();
    const payload = Uint8Array.from({ length: 21 }, (_, index) => index);
    await bucket.put("docs/big-move.bin", payload, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    const directPutKeys = trackDirectPuts(bucket);

    await moveObject(bucket as unknown as R2Bucket, "docs/big-move.bin", "docs/moved-big.bin", smallLimits);

    expect(directPutKeys).not.toContain("docs/moved-big.bin");
    const moved = await bucket.get("docs/moved-big.bin");
    expect(moved).not.toBeNull();
    expect(new Uint8Array(await moved!.arrayBuffer())).toEqual(payload);
    expect(await bucket.get("docs/big-move.bin")).toBeNull();
  });

  it("keeps the single-put fast path for objects within the limit", async () => {
    const bucket = new MemoryR2Bucket();
    await bucket.put("docs/small-move.bin", "small");
    const directPutKeys = trackDirectPuts(bucket);

    await moveObject(bucket as unknown as R2Bucket, "docs/small-move.bin", "docs/moved-small.bin", smallLimits);

    expect(directPutKeys).toEqual(["docs/moved-small.bin"]);
    expect(await bucket.get("docs/small-move.bin")).toBeNull();
  });
});
