import { describe, expect, it } from "vitest";
import { createUploadSlotGate } from "../web/src/hooks/useUploadQueue";

describe("upload slot gate", () => {
  it("caps concurrent holders and hands slots to waiters in order", async () => {
    const gate = createUploadSlotGate(2);

    await gate.acquire();
    await gate.acquire();

    let thirdAcquired = false;
    const third = gate.acquire().then(() => {
      thirdAcquired = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(thirdAcquired).toBe(false);

    gate.release();
    await third;
    expect(thirdAcquired).toBe(true);
  });

  it("survives release beyond the held count", async () => {
    const gate = createUploadSlotGate(1);
    await gate.acquire();
    gate.release();
    // A stray extra release must not corrupt the gate for future acquires.
    gate.release();

    await gate.acquire();
    let secondAcquired = false;
    const second = gate.acquire().then(() => {
      secondAcquired = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondAcquired).toBe(false);
    gate.release();
    await second;
    expect(secondAcquired).toBe(true);
  });
});
