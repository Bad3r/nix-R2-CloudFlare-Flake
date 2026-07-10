import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { UploadSessionDurableObject, type UploadSessionRecord } from "../src/upload-sessions";
import { createMemoryDurableObjectState, MemoryR2Bucket } from "./helpers/memory";

const EXPIRED_RETENTION_MS = 24 * 60 * 60 * 1000;

function makeEnv(bucket: MemoryR2Bucket): Env {
  return {
    FILES_BUCKET: bucket as unknown as R2Bucket,
  } as unknown as Env;
}

function makeSessionRecord(overrides: Partial<UploadSessionRecord>): UploadSessionRecord {
  const now = Date.now();
  return {
    sessionId: "sess-test",
    ownerId: "owner@example.com",
    bucket: "files-bucket-test",
    uploadId: "upload-test",
    objectKey: "uploads/file.bin",
    stagingKey: ".r2e-staging/sess-test/uploads/file.bin",
    filename: "file.bin",
    contentType: "application/octet-stream",
    declaredSize: 1024,
    sha256: null,
    prefix: "uploads/",
    maxParts: 10000,
    maxFileBytes: 0,
    partSizeBytes: 8 * 1024 * 1024,
    createdAt: new Date(now - 3600_000).toISOString(),
    expiresAt: new Date(now + 3600_000).toISOString(),
    status: "active",
    completedAt: null,
    abortedAt: null,
    signedParts: {},
    ...overrides,
  };
}

describe("UploadSessionDurableObject expiry cleanup", () => {
  it("aborts the R2 multipart upload when pruning an expired in-flight session", async () => {
    const bucket = new MemoryR2Bucket();
    const { state, storage } = createMemoryDurableObjectState();
    const env = makeEnv(bucket);
    const durable = new UploadSessionDurableObject(state, env);

    const upload = await bucket.createMultipartUpload(".r2e-staging/sess-1/uploads/orphan.bin");
    const session = makeSessionRecord({
      sessionId: "sess-1",
      uploadId: upload.uploadId,
      objectKey: "uploads/orphan.bin",
      stagingKey: upload.key,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await storage.put("session:sess-1", session);

    const response = await durable.fetch(
      new Request("https://upload-sessions/gc-expired", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(200);

    // The multipart upload must be gone: resuming it now fails.
    expect(() => bucket.resumeMultipartUpload(upload.key, upload.uploadId)).toThrow();

    const stored = await storage.get<UploadSessionRecord>("session:sess-1");
    expect(stored?.status).toBe("expired");
  });

  it("deletes an orphaned staged object without touching the target key", async () => {
    const bucket = new MemoryR2Bucket();
    const { state, storage } = createMemoryDurableObjectState();
    const durable = new UploadSessionDurableObject(state, makeEnv(bucket));

    // Simulate a crash between staged completion and promotion: the staged
    // object exists, the multipart upload is already consumed, and the target
    // key still holds the user's original object.
    await bucket.put("uploads/target.bin", "original content");
    await bucket.put(".r2e-staging/sess-2/uploads/target.bin", "staged content");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const session = makeSessionRecord({
        sessionId: "sess-2",
        uploadId: "already-consumed-upload",
        objectKey: "uploads/target.bin",
        stagingKey: ".r2e-staging/sess-2/uploads/target.bin",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      await storage.put("session:sess-2", session);

      await durable.fetch(new Request("https://upload-sessions/gc-expired", { method: "POST", body: "{}" }));

      expect(await bucket.get(".r2e-staging/sess-2/uploads/target.bin")).toBeNull();
      const original = await bucket.get("uploads/target.bin");
      expect(await original?.text()).toBe("original content");
      // The failed abort of the consumed uploadId is logged, not swallowed.
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("never deletes the target key for legacy sessions staged at the target", async () => {
    const bucket = new MemoryR2Bucket();
    const { state, storage } = createMemoryDurableObjectState();
    const durable = new UploadSessionDurableObject(state, makeEnv(bucket));

    await bucket.put("uploads/legacy.bin", "legacy object");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const session = makeSessionRecord({
        sessionId: "sess-legacy",
        uploadId: "legacy-upload",
        objectKey: "uploads/legacy.bin",
        // Legacy records staged directly at the target key.
        stagingKey: "uploads/legacy.bin",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      await storage.put("session:sess-legacy", session);

      await durable.fetch(new Request("https://upload-sessions/gc-expired", { method: "POST", body: "{}" }));

      const kept = await bucket.get("uploads/legacy.bin");
      expect(await kept?.text()).toBe("legacy object");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not abort uploads for completed sessions that age out", async () => {
    const bucket = new MemoryR2Bucket();
    const { state, storage } = createMemoryDurableObjectState();
    const durable = new UploadSessionDurableObject(state, makeEnv(bucket));

    await bucket.put("uploads/done.bin", "completed upload");
    const session = makeSessionRecord({
      sessionId: "sess-done",
      objectKey: "uploads/done.bin",
      stagingKey: ".r2e-staging/sess-done/uploads/done.bin",
      status: "completed",
      completedAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await storage.put("session:sess-done", session);

    await durable.fetch(new Request("https://upload-sessions/gc-expired", { method: "POST", body: "{}" }));

    const stored = await storage.get<UploadSessionRecord>("session:sess-done");
    expect(stored?.status).toBe("expired");
    const object = await bucket.get("uploads/done.bin");
    expect(await object?.text()).toBe("completed upload");
  });

  it("aborts the R2 upload when an expired session is loaded via /get", async () => {
    const bucket = new MemoryR2Bucket();
    const { state, storage } = createMemoryDurableObjectState();
    const durable = new UploadSessionDurableObject(state, makeEnv(bucket));

    const upload = await bucket.createMultipartUpload(".r2e-staging/sess-3/uploads/late.bin");
    const session = makeSessionRecord({
      sessionId: "sess-3",
      uploadId: upload.uploadId,
      objectKey: "uploads/late.bin",
      stagingKey: upload.key,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await storage.put("session:sess-3", session);

    const response = await durable.fetch(
      new Request("https://upload-sessions/get", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-3" }),
      }),
    );
    expect(response.status).toBe(410);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("upload_session_expired");
    expect(() => bucket.resumeMultipartUpload(upload.key, upload.uploadId)).toThrow();
  });

  it("schedules an alarm for the session expiry on create", async () => {
    const bucket = new MemoryR2Bucket();
    const { state, storage } = createMemoryDurableObjectState();
    const durable = new UploadSessionDurableObject(state, makeEnv(bucket));

    const session = makeSessionRecord({ sessionId: "sess-alarm", status: "init" });
    const response = await durable.fetch(
      new Request("https://upload-sessions/create", {
        method: "POST",
        body: JSON.stringify({ session, maxConcurrentUploads: 0 }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await storage.getAlarm()).toBe(Date.parse(session.expiresAt));
  });

  it("alarm() prunes, reschedules for retention, then deletes and clears the alarm", async () => {
    const bucket = new MemoryR2Bucket();
    const { state, storage } = createMemoryDurableObjectState();
    const durable = new UploadSessionDurableObject(state, makeEnv(bucket));

    const upload = await bucket.createMultipartUpload(".r2e-staging/sess-4/uploads/gone.bin");
    const expiresAt = new Date(Date.now() - EXPIRED_RETENTION_MS - 60_000).toISOString();
    const session = makeSessionRecord({
      sessionId: "sess-4",
      uploadId: upload.uploadId,
      objectKey: "uploads/gone.bin",
      stagingKey: upload.key,
      expiresAt,
    });
    await storage.put("session:sess-4", session);

    // First alarm: the session is flipped to expired and its upload aborted;
    // the next alarm is scheduled for the retention deletion.
    await durable.alarm();
    expect((await storage.get<UploadSessionRecord>("session:sess-4"))?.status).toBe("expired");
    expect(() => bucket.resumeMultipartUpload(upload.key, upload.uploadId)).toThrow();
    expect(await storage.getAlarm()).toBe(Date.parse(expiresAt) + EXPIRED_RETENTION_MS);

    // Second alarm: retention has passed, the record is deleted and no
    // further alarm is needed.
    await durable.alarm();
    expect(await storage.get<UploadSessionRecord>("session:sess-4")).toBeUndefined();
    expect(await storage.getAlarm()).toBeNull();
  });
});
