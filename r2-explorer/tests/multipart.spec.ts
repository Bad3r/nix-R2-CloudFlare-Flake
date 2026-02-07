import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { accessHeaders, createTestEnv } from "./helpers/memory";

describe("multipart upload flow", () => {
  it("uploads and completes multipart object", async () => {
    const { env } = await createTestEnv();
    const app = createApp();

    const initBody = JSON.stringify({
      key: "uploads/sample.bin",
      contentType: "application/octet-stream",
    });
    const initResponse = await app.fetch(
      new Request("https://files.example.com/api/upload/init", {
        method: "POST",
        headers: {
          ...accessHeaders(),
          "content-type": "application/json",
        },
        body: initBody,
      }),
      env,
    );
    expect(initResponse.status).toBe(200);
    const initPayload = (await initResponse.json()) as { uploadId: string; key: string };
    expect(initPayload.uploadId).toBeTruthy();

    const uploadPartResponse = await app.fetch(
      new Request(
        `https://files.example.com/api/upload/part?key=${encodeURIComponent(initPayload.key)}&uploadId=${encodeURIComponent(initPayload.uploadId)}&partNumber=1`,
        {
          method: "POST",
          headers: accessHeaders(),
          body: new TextEncoder().encode("abc"),
        },
      ),
      env,
    );
    expect(uploadPartResponse.status).toBe(200);
    const uploadPartPayload = (await uploadPartResponse.json()) as { partNumber: number; etag: string };
    expect(uploadPartPayload.partNumber).toBe(1);
    expect(uploadPartPayload.etag).toBeTruthy();

    const completeBody = JSON.stringify({
      key: initPayload.key,
      uploadId: initPayload.uploadId,
      parts: [
        {
          partNumber: 1,
          etag: uploadPartPayload.etag,
        },
      ],
    });
    const completeResponse = await app.fetch(
      new Request("https://files.example.com/api/upload/complete", {
        method: "POST",
        headers: {
          ...accessHeaders(),
          "content-type": "application/json",
        },
        body: completeBody,
      }),
      env,
    );
    expect(completeResponse.status).toBe(200);

    const downloadResponse = await app.fetch(
      new Request(
        `https://files.example.com/api/download?key=${encodeURIComponent(initPayload.key)}`,
        {
          headers: accessHeaders(),
        },
      ),
      env,
    );
    expect(downloadResponse.status).toBe(200);
    const bytes = new Uint8Array(await downloadResponse.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toBe("abc");
  });
});
