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
    overwrite: false,
    promotionLeaseExpiresAt: null,
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

  it("reclaims an expired staged session's object without attempting a doomed multipart abort", async () => {
    const bucket = new MemoryR2Bucket();
    const { state, storage } = createMemoryDurableObjectState();
    const durable = new UploadSessionDurableObject(state, makeEnv(bucket));

    // A staged session has already run completeMultipartUpload successfully,
    // so its uploadId is consumed; abort would always fail. Cleanup must skip
    // straight to reclaiming the staged object instead of logging a
    // guaranteed failure.
    await bucket.put(".r2e-staging/sess-staged-expiry/uploads/big.bin", "fully assembled content");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const session = makeSessionRecord({
        sessionId: "sess-staged-expiry",
        uploadId: "already-consumed-upload",
        objectKey: "uploads/big.bin",
        stagingKey: ".r2e-staging/sess-staged-expiry/uploads/big.bin",
        status: "staged",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      await storage.put("session:sess-staged-expiry", session);

      await durable.fetch(new Request("https://upload-sessions/gc-expired", { method: "POST", body: "{}" }));

      expect(await bucket.get(".r2e-staging/sess-staged-expiry/uploads/big.bin")).toBeNull();
      expect(errorSpy).not.toHaveBeenCalled();
      const stored = await storage.get<UploadSessionRecord>("session:sess-staged-expiry");
      expect(stored?.status).toBe("expired");
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

  it("expiry of a staged session that never promoted leaves the original object at the target key (RW-1)", async () => {
    const bucket = new MemoryR2Bucket();
    const { state, storage } = createMemoryDurableObjectState();
    const durable = new UploadSessionDurableObject(state, makeEnv(bucket));

    // Models the root-cause fix's invariant: a session that reached "staged"
    // (backup-then-promote in flight) but whose promotion never succeeded
    // never had its target key touched, since backing up copies without
    // deleting and only a successful promotion ever writes objectKey. The
    // only resource this expiry cleanup may discard is the unpromoted
    // staged upload; the client was already told the promotion failed.
    await bucket.put("uploads/never-promoted.bin", "original content");
    await bucket.put(".r2e-staging/sess-rw1/uploads/never-promoted.bin", "new content that never got promoted");
    const session = makeSessionRecord({
      sessionId: "sess-rw1",
      uploadId: "already-consumed-upload",
      objectKey: "uploads/never-promoted.bin",
      stagingKey: ".r2e-staging/sess-rw1/uploads/never-promoted.bin",
      status: "staged",
      overwrite: true,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await storage.put("session:sess-rw1", session);

    await durable.fetch(new Request("https://upload-sessions/gc-expired", { method: "POST", body: "{}" }));

    expect(await bucket.get(".r2e-staging/sess-rw1/uploads/never-promoted.bin")).toBeNull();
    const original = await bucket.get("uploads/never-promoted.bin");
    expect(await original?.text()).toBe("original content");
    const stored = await storage.get<UploadSessionRecord>("session:sess-rw1");
    expect(stored?.status).toBe("expired");
  });
});

describe("UploadSessionDurableObject staged transition and promotion lease (UPS-001)", () => {
  it("marks an active session staged and acquires the lease", async () => {
    const bucket = new MemoryR2Bucket();
    const { state, storage } = createMemoryDurableObjectState();
    const durable = new UploadSessionDurableObject(state, makeEnv(bucket));

    const session = makeSessionRecord({ sessionId: "sess-stage", uploadId: "upload-stage" });
    await storage.put("session:sess-stage", session);

    const response = await durable.fetch(
      new Request("https://upload-sessions/acquire-promotion-lease", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-stage", uploadId: "upload-stage" }),
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { session: UploadSessionRecord };
    expect(payload.session.status).toBe("staged");
    expect(payload.session.promotionLeaseExpiresAt).not.toBeNull();
    expect(Date.parse(payload.session.promotionLeaseExpiresAt!)).toBeGreaterThan(Date.now());
  });

  it("rejects acquire-promotion-lease for a session that is not active or staged", async () => {
    const bucket = new MemoryR2Bucket();
    const { state, storage } = createMemoryDurableObjectState();
    const durable = new UploadSessionDurableObject(state, makeEnv(bucket));

    const session = makeSessionRecord({
      sessionId: "sess-completed",
      uploadId: "upload-completed",
      status: "completed",
    });
    await storage.put("session:sess-completed", session);

    const response = await durable.fetch(
      new Request("https://upload-sessions/acquire-promotion-lease", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-completed", uploadId: "upload-completed" }),
      }),
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("upload_session_not_active");
  });

  it("rejects a second lease acquisition while the first is still live", async () => {
    const bucket = new MemoryR2Bucket();
    const { state, storage } = createMemoryDurableObjectState();
    const durable = new UploadSessionDurableObject(state, makeEnv(bucket));

    const session = makeSessionRecord({ sessionId: "sess-race", uploadId: "upload-race" });
    await storage.put("session:sess-race", session);

    const first = await durable.fetch(
      new Request("https://upload-sessions/acquire-promotion-lease", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-race", uploadId: "upload-race" }),
      }),
    );
    expect(first.status).toBe(200);

    const second = await durable.fetch(
      new Request("https://upload-sessions/acquire-promotion-lease", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-race", uploadId: "upload-race" }),
      }),
    );
    expect(second.status).toBe(409);
    const payload = (await second.json()) as { error: { code: string; details?: { retryAfterSeconds?: number } } };
    expect(payload.error.code).toBe("upload_promotion_in_progress");
    expect(payload.error.details?.retryAfterSeconds).toBeGreaterThan(0);

    // The session is unaffected by the rejected second attempt: still staged
    // with the first attempt's lease, not overwritten.
    const stored = await storage.get<UploadSessionRecord>("session:sess-race");
    expect(stored?.status).toBe("staged");
  });

  it("releases the lease so a subsequent acquire succeeds immediately", async () => {
    const bucket = new MemoryR2Bucket();
    const { state, storage } = createMemoryDurableObjectState();
    const durable = new UploadSessionDurableObject(state, makeEnv(bucket));

    const session = makeSessionRecord({ sessionId: "sess-release", uploadId: "upload-release" });
    await storage.put("session:sess-release", session);

    await durable.fetch(
      new Request("https://upload-sessions/acquire-promotion-lease", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-release", uploadId: "upload-release" }),
      }),
    );
    const releaseResponse = await durable.fetch(
      new Request("https://upload-sessions/release-promotion-lease", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-release", uploadId: "upload-release" }),
      }),
    );
    expect(releaseResponse.status).toBe(200);
    expect(((await releaseResponse.json()) as { session: UploadSessionRecord }).session.promotionLeaseExpiresAt).toBeNull();

    const reacquire = await durable.fetch(
      new Request("https://upload-sessions/acquire-promotion-lease", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-release", uploadId: "upload-release" }),
      }),
    );
    expect(reacquire.status).toBe(200);
  });

  it("acquires the lease again once the previous one has expired", async () => {
    const bucket = new MemoryR2Bucket();
    const { state, storage } = createMemoryDurableObjectState();
    const durable = new UploadSessionDurableObject(state, makeEnv(bucket));

    const session = makeSessionRecord({
      sessionId: "sess-lease-expired",
      uploadId: "upload-lease-expired",
      status: "staged",
      promotionLeaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await storage.put("session:sess-lease-expired", session);

    const response = await durable.fetch(
      new Request("https://upload-sessions/acquire-promotion-lease", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-lease-expired", uploadId: "upload-lease-expired" }),
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { session: UploadSessionRecord };
    expect(payload.session.status).toBe("staged");
    expect(Date.parse(payload.session.promotionLeaseExpiresAt!)).toBeGreaterThan(Date.now());
  });

  it("rejects abort while a live promotion lease exists, touching neither storage nor R2", async () => {
    const bucket = new MemoryR2Bucket();
    const { state, storage } = createMemoryDurableObjectState();
    const durable = new UploadSessionDurableObject(state, makeEnv(bucket));

    const session = makeSessionRecord({ sessionId: "sess-abort-race", uploadId: "upload-abort-race" });
    await storage.put("session:sess-abort-race", session);

    await durable.fetch(
      new Request("https://upload-sessions/acquire-promotion-lease", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-abort-race", uploadId: "upload-abort-race" }),
      }),
    );

    const abortResponse = await durable.fetch(
      new Request("https://upload-sessions/abort", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-abort-race", uploadId: "upload-abort-race" }),
      }),
    );
    expect(abortResponse.status).toBe(409);
    const payload = (await abortResponse.json()) as {
      error: { code: string; details?: { retryAfterSeconds?: number } };
    };
    expect(payload.error.code).toBe("upload_promotion_in_progress");
    expect(payload.error.details?.retryAfterSeconds).toBeGreaterThan(0);

    const stored = await storage.get<UploadSessionRecord>("session:sess-abort-race");
    expect(stored?.status).toBe("staged");
    expect(stored?.promotionLeaseExpiresAt).not.toBeNull();
  });

  it("allows abort once the promotion lease is released", async () => {
    const bucket = new MemoryR2Bucket();
    const { state, storage } = createMemoryDurableObjectState();
    const durable = new UploadSessionDurableObject(state, makeEnv(bucket));

    const session = makeSessionRecord({
      sessionId: "sess-abort-after-release",
      uploadId: "upload-abort-after-release",
    });
    await storage.put("session:sess-abort-after-release", session);

    await durable.fetch(
      new Request("https://upload-sessions/acquire-promotion-lease", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-abort-after-release", uploadId: "upload-abort-after-release" }),
      }),
    );
    await durable.fetch(
      new Request("https://upload-sessions/release-promotion-lease", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-abort-after-release", uploadId: "upload-abort-after-release" }),
      }),
    );

    const abortResponse = await durable.fetch(
      new Request("https://upload-sessions/abort", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-abort-after-release", uploadId: "upload-abort-after-release" }),
      }),
    );
    expect(abortResponse.status).toBe(200);
    expect(((await abortResponse.json()) as { session: UploadSessionRecord }).session.status).toBe("aborted");
  });

  it("allows abort once the promotion lease has expired", async () => {
    const bucket = new MemoryR2Bucket();
    const { state, storage } = createMemoryDurableObjectState();
    const durable = new UploadSessionDurableObject(state, makeEnv(bucket));

    const session = makeSessionRecord({
      sessionId: "sess-abort-after-expiry",
      uploadId: "upload-abort-after-expiry",
      status: "staged",
      promotionLeaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await storage.put("session:sess-abort-after-expiry", session);

    const abortResponse = await durable.fetch(
      new Request("https://upload-sessions/abort", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-abort-after-expiry", uploadId: "upload-abort-after-expiry" }),
      }),
    );
    expect(abortResponse.status).toBe(200);
    expect(((await abortResponse.json()) as { session: UploadSessionRecord }).session.status).toBe("aborted");
  });

  it("completes a staged session via /complete", async () => {
    const bucket = new MemoryR2Bucket();
    const { state, storage } = createMemoryDurableObjectState();
    const durable = new UploadSessionDurableObject(state, makeEnv(bucket));

    const session = makeSessionRecord({ sessionId: "sess-resume", uploadId: "upload-resume", status: "staged" });
    await storage.put("session:sess-resume", session);

    const response = await durable.fetch(
      new Request("https://upload-sessions/complete", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-resume", uploadId: "upload-resume" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { session: UploadSessionRecord }).session.status).toBe("completed");
  });

  it("aborts a staged session via /abort", async () => {
    const bucket = new MemoryR2Bucket();
    const { state, storage } = createMemoryDurableObjectState();
    const durable = new UploadSessionDurableObject(state, makeEnv(bucket));

    const session = makeSessionRecord({
      sessionId: "sess-abort-staged",
      uploadId: "upload-abort-staged",
      status: "staged",
    });
    await storage.put("session:sess-abort-staged", session);

    const response = await durable.fetch(
      new Request("https://upload-sessions/abort", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-abort-staged", uploadId: "upload-abort-staged" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { session: UploadSessionRecord }).session.status).toBe("aborted");
  });

  it("a staged session blocks a second init for the same key exactly like active, until it completes or aborts (RW-2)", async () => {
    const bucket = new MemoryR2Bucket();
    const { state, storage } = createMemoryDurableObjectState();
    const durable = new UploadSessionDurableObject(state, makeEnv(bucket));

    const first = makeSessionRecord({
      sessionId: "sess-rw2-first",
      uploadId: "upload-rw2-first",
      objectKey: "uploads/rw2-race.bin",
      stagingKey: ".r2e-staging/sess-rw2-first/uploads/rw2-race.bin",
    });
    const createFirst = await durable.fetch(
      new Request("https://upload-sessions/create", {
        method: "POST",
        body: JSON.stringify({ session: first, maxConcurrentUploads: 0 }),
      }),
    );
    expect(createFirst.status).toBe(200);

    // Push the first session to "staged", exactly what /complete does right
    // before its own existence-check/backup/promote sequence.
    const leaseResponse = await durable.fetch(
      new Request("https://upload-sessions/acquire-promotion-lease", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-rw2-first", uploadId: "upload-rw2-first" }),
      }),
    );
    expect(leaseResponse.status).toBe(200);

    const second = makeSessionRecord({
      sessionId: "sess-rw2-second",
      uploadId: "upload-rw2-second",
      objectKey: "uploads/rw2-race.bin",
      stagingKey: ".r2e-staging/sess-rw2-second/uploads/rw2-race.bin",
    });
    const createSecond = await durable.fetch(
      new Request("https://upload-sessions/create", {
        method: "POST",
        body: JSON.stringify({ session: second, maxConcurrentUploads: 0 }),
      }),
    );
    expect(createSecond.status).toBe(409);
    expect(((await createSecond.json()) as { error: { code: string } }).error.code).toBe("upload_object_key_in_use");

    // Once the first session completes, the key is free again.
    const completeFirst = await durable.fetch(
      new Request("https://upload-sessions/complete", {
        method: "POST",
        body: JSON.stringify({ sessionId: "sess-rw2-first", uploadId: "upload-rw2-first" }),
      }),
    );
    expect(completeFirst.status).toBe(200);

    const createThird = await durable.fetch(
      new Request("https://upload-sessions/create", {
        method: "POST",
        body: JSON.stringify({ session: second, maxConcurrentUploads: 0 }),
      }),
    );
    expect(createThird.status).toBe(200);
  });
});
