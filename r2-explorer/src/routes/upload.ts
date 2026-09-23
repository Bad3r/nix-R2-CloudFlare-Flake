import type { Hono } from "hono";
import type { AppContext } from "../app-context";
import { HttpError } from "../http";
import { guessContentType, normalizeMimeType, normalizeObjectKey } from "../object-response";
import {
  abortMultipartUpload,
  backupObjectToTrash,
  completeMultipartUpload,
  type CopyObjectOptions,
  createMultipartUpload,
  headObject,
  promoteObject,
} from "../r2";
import { randomTokenId } from "../random";
import {
  simpleOkResponseSchema,
  uploadAbortBodySchema,
  uploadCompleteBodySchema,
  uploadCompleteResponseSchema,
  uploadInitBodySchema,
  uploadInitResponseSchema,
  uploadSignPartBodySchema,
  uploadSignPartResponseSchema,
} from "../schemas";
import type { Env } from "../types";
import { isGenericOrMissingContentType, magicMimeMatchesDeclared, uploadedMagicMime } from "../upload/magic-mime";
import { extractExtension, getUploadPolicy, normalizeUploadPrefix, R2_MAX_PART_SIZE_BYTES } from "../upload/policy";
import { signMultipartUploadPart } from "../upload-signing";
import {
  PROMOTION_LEASE_MS,
  acquirePromotionLease,
  createUploadSession,
  markUploadSessionAborted,
  markUploadSessionCompleted,
  recordUploadSessionSignedPart,
  releasePromotionLease,
  renewPromotionLease,
  requireUploadSession,
  type UploadSessionRecord,
} from "../upload-sessions";
import { jsonValidated, readJsonBody, requireUploadActor } from "../validate";

/**
 * Reserved key prefix where multipart uploads are assembled before
 * validation. Objects are promoted from here to their final key only after
 * every post-complete check passes, so a failed validation never destroys a
 * previously stored object at the target key.
 */
export const UPLOAD_STAGING_PREFIX = ".r2e-staging/";

/** Build the staging key a session assembles its multipart upload under. */
export function stagingObjectKey(sessionId: string, objectKey: string): string {
  return `${UPLOAD_STAGING_PREFIX}${sessionId}/${objectKey}`;
}

function requireUploadFilename(filename: string): string {
  const trimmed = filename.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") {
    throw new HttpError(400, "invalid_upload_filename", "Upload filename must be non-empty.");
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new HttpError(400, "invalid_upload_filename", "Upload filename cannot contain path separators.");
  }
  if (trimmed.length > 255) {
    throw new HttpError(400, "invalid_upload_filename", "Upload filename exceeds 255 characters.");
  }
  return trimmed;
}

function buildUploadObjectKey(prefix: string, filename: string): string {
  return `${prefix}${filename}`;
}

function prefixAllowed(prefix: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) {
    return true;
  }
  return allowlist.some((allowedPrefix) => prefix.startsWith(allowedPrefix));
}

function expectedPartCount(declaredSize: number, partSizeBytes: number): number {
  return Math.max(1, Math.ceil(declaredSize / partSizeBytes));
}

function validateCompleteParts(
  parts: Array<{ partNumber: number; etag: string }>,
  maxParts: number,
): void {
  let previousPartNumber = 0;
  const seen = new Set<number>();
  for (const part of parts) {
    if (part.partNumber > maxParts) {
      throw new HttpError(400, "invalid_part_number", "Part number exceeds allowed max parts.", {
        partNumber: part.partNumber,
        maxParts,
      });
    }
    if (seen.has(part.partNumber)) {
      throw new HttpError(400, "duplicate_part_number", "Duplicate part number in complete request.", {
        partNumber: part.partNumber,
      });
    }
    if (part.partNumber <= previousPartNumber) {
      throw new HttpError(400, "invalid_part_order", "Parts must be strictly ordered by partNumber.");
    }
    seen.add(part.partNumber);
    previousPartNumber = part.partNumber;
  }
}

/**
 * Wrap a storage call so a raw platform failure (an R2 subrequest-limit or
 * transient error, not already an HttpError) surfaces as a specific,
 * actionable HttpError instead of falling through to the generic 500
 * internal_error handler. An HttpError thrown by the wrapped call passes
 * through unchanged.
 */
async function wrapUploadStorageError<T>(promise: Promise<T>, code: string, action: string): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(500, code, `Failed to ${action}: ${error instanceof Error ? error.message : String(error)}.`);
  }
}

/** True when object at the target key is this session's own promoted upload (marker set at /init). */
function promotedBySession(object: R2Object, sessionId: string): boolean {
  return object.customMetadata?.uploadSessionId === sessionId;
}

/** Session store payload carrying the lease token the session was last seen with. */
function leasePayload(session: UploadSessionRecord): {
  sessionId: string;
  uploadId: string;
  promotionLeaseToken?: string;
} {
  return {
    sessionId: session.sessionId,
    uploadId: session.uploadId,
    ...(session.promotionLeaseToken ? { promotionLeaseToken: session.promotionLeaseToken } : {}),
  };
}

/**
 * copyObject beforeWrite hook for a held promotion lease: renews once less
 * than half the lease window is left, so a copy loop that outlives the
 * window keeps its lease, and surfaces the store's 409 when a retry has taken
 * the lease over, which aborts the copy before it can write a stale part or
 * complete a target that the new holder now owns.
 */
function promotionLeaseRenewer(env: Env, actor: string, session: UploadSessionRecord): () => Promise<void> {
  let leaseExpiresMs = session.promotionLeaseExpiresAt ? Date.parse(session.promotionLeaseExpiresAt) : Number.NaN;
  return async () => {
    if (Number.isFinite(leaseExpiresMs) && Date.now() < leaseExpiresMs - PROMOTION_LEASE_MS / 2) {
      return;
    }
    const renewed = await renewPromotionLease(env, actor, leasePayload(session));
    leaseExpiresMs = renewed.promotionLeaseExpiresAt ? Date.parse(renewed.promotionLeaseExpiresAt) : Number.NaN;
  };
}

/**
 * Discard a staged-but-invalid completed upload: mark the session aborted,
 * delete the staged object, and rethrow the validation error. The abort runs
 * first, as in /abort: the store refuses it while another request holds the
 * promotion lease, and that request may still be copying the staged object
 * (two Worker versions can disagree on upload policy mid-rollout). The final
 * target key is never touched, so a pre-existing object survives rejected
 * overwrites. For legacy sessions staged directly at the target key the
 * delete removes the invalid completed bytes, matching their old behavior.
 */
async function rejectStagedUpload(
  env: Env,
  actor: string,
  session: UploadSessionRecord,
  error: HttpError,
): Promise<never> {
  const aborted = await markUploadSessionAborted(env, actor, {
    sessionId: session.sessionId,
    uploadId: session.uploadId,
  }).then(
    () => true,
    (abortError) => {
      // A failed status transition only leaves the session to expire on its
      // own, so log instead of masking the validation error below.
      console.error(`Failed to mark upload session ${session.sessionId} aborted:`, abortError);
      return false;
    },
  );
  // Legacy sessions never hold a promotion lease, and expiry never reclaims
  // their bytes at the target key, so only they are deleted without the abort.
  if (aborted || session.stagingKey === session.objectKey) {
    await env.FILES_BUCKET.delete(session.stagingKey).catch((deleteError) => {
      // A transient delete failure (R2 rate limit, network blip) must not mask
      // the validation error thrown below with a 500. The staged object lives
      // under the reserved staging prefix and is reclaimed when the session
      // expires, so log and continue.
      console.error(`Failed to delete staged object ${session.stagingKey}:`, deleteError);
    });
  }
  throw error;
}

/**
 * Register the multipart upload control-plane routes:
 * POST /api/v2/upload/{init,sign-part,complete,abort}.
 */
export function registerUploadRoutes(app: Hono<AppContext>): void {
  app.post("/api/v2/upload/init", async (c) => {
    const body = readJsonBody(c, uploadInitBodySchema);
    const policy = getUploadPolicy(c);
    const actor = requireUploadActor(c);
    const filename = requireUploadFilename(body.filename);
    const prefix = normalizeUploadPrefix(body.prefix);
    if (prefix.startsWith(UPLOAD_STAGING_PREFIX)) {
      throw new HttpError(
        400,
        "invalid_upload_prefix",
        `Upload prefix cannot target the reserved staging prefix: ${UPLOAD_STAGING_PREFIX}`,
      );
    }
    if (!prefixAllowed(prefix, policy.prefixAllowlist)) {
      throw new HttpError(403, "upload_prefix_forbidden", "Upload prefix is not allowed for this deployment.", {
        prefix,
        allowedPrefixes: policy.prefixAllowlist,
      });
    }

    const extension = extractExtension(filename);
    if (extension && policy.blockedExtensions.includes(extension)) {
      throw new HttpError(400, "upload_extension_blocked", "File extension is blocked by server policy.", {
        extension,
        blockedExtensions: policy.blockedExtensions,
      });
    }
    if (policy.allowedExtensions.length > 0 && !policy.allowedExtensions.includes(extension)) {
      throw new HttpError(400, "upload_extension_not_allowed", "File extension is not allowed.", {
        extension,
        allowedExtensions: policy.allowedExtensions,
      });
    }

    const contentType = body.contentType?.trim().length
      ? body.contentType.trim()
      : guessContentType(filename).replace(/;.*$/, "");
    const normalizedContentType = normalizeMimeType(contentType);
    if (policy.blockedMime.includes(normalizedContentType)) {
      throw new HttpError(400, "upload_content_type_blocked", "Content-Type is blocked by server policy.", {
        contentType: normalizedContentType,
        blockedMime: policy.blockedMime,
      });
    }
    if (policy.allowedMime.length > 0 && !policy.allowedMime.includes(normalizedContentType)) {
      throw new HttpError(400, "upload_content_type_not_allowed", "Content-Type is not allowed.", {
        contentType: normalizedContentType,
        allowedMime: policy.allowedMime,
      });
    }

    const declaredSize = body.declaredSize;
    if (declaredSize === 0) {
      throw new HttpError(
        400,
        "upload_empty_file",
        "Empty files cannot be uploaded; declaredSize must be greater than zero.",
      );
    }
    if (policy.maxFileBytes > 0 && declaredSize > policy.maxFileBytes) {
      throw new HttpError(413, "upload_size_limit", "Declared file size exceeds configured maximum.", {
        declaredSize,
        maxFileBytes: policy.maxFileBytes,
      });
    }
    const partsNeeded = expectedPartCount(declaredSize, policy.partSizeBytes);
    if (partsNeeded > policy.maxParts) {
      throw new HttpError(413, "upload_part_limit", "Declared file size exceeds maximum supported multipart parts.", {
        partsNeeded,
        maxParts: policy.maxParts,
      });
    }

    const key = normalizeObjectKey(buildUploadObjectKey(prefix, filename));
    const overwrite = body.overwrite === true;
    if (!overwrite) {
      const existing = await headObject(c.env.FILES_BUCKET, key);
      if (existing) {
        throw new HttpError(409, "object_exists", "An object already exists at the target key.", { key });
      }
    }

    const sessionId = randomTokenId(28);
    const stagingKey = stagingObjectKey(sessionId, key);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + policy.sessionTtlSec * 1000).toISOString();

    const upload = await createMultipartUpload(c.env.FILES_BUCKET, stagingKey, {
      contentType,
      customMetadata: {
        originalFilename: filename,
        // Travels with the bytes through promotion (copyObject preserves
        // customMetadata), so a retry can tell its own promoted object from
        // an unrelated one at the target key; see promotedBySession.
        uploadSessionId: sessionId,
        ...(body.sha256 ? { declaredSha256: body.sha256 } : {}),
      },
    });

    const sessionRecord: UploadSessionRecord = {
      sessionId,
      ownerId: actor,
      bucket: policy.bucketName,
      uploadId: upload.uploadId,
      objectKey: key,
      stagingKey: upload.key,
      filename,
      contentType,
      declaredSize,
      sha256: body.sha256 ?? null,
      prefix,
      maxParts: policy.maxParts,
      maxFileBytes: policy.maxFileBytes,
      partSizeBytes: policy.partSizeBytes,
      createdAt,
      expiresAt,
      status: "init",
      completedAt: null,
      abortedAt: null,
      signedParts: {},
      overwrite,
      promotionLeaseExpiresAt: null,
      promotionLeaseToken: null,
    };

    try {
      await createUploadSession(c.env, actor, {
        session: sessionRecord,
        maxConcurrentUploads: policy.maxConcurrentPerUser,
      });
    } catch (error) {
      await abortMultipartUpload(c.env.FILES_BUCKET, upload.key, upload.uploadId).catch((abortError) => {
        console.error(`Failed to abort multipart upload ${upload.uploadId} after init failure:`, abortError);
      });
      throw error;
    }

    return jsonValidated(uploadInitResponseSchema, {
      sessionId,
      objectKey: key,
      uploadId: upload.uploadId,
      expiresAt,
      partSizeBytes: policy.partSizeBytes,
      maxParts: policy.maxParts,
      signPartTtlSec: policy.signPartTtlSec,
      allowedMime: policy.allowedMime,
      allowedExt: policy.allowedExtensions,
    });
  });

  app.post("/api/v2/upload/sign-part", async (c) => {
    const body = readJsonBody(c, uploadSignPartBodySchema);
    const actor = requireUploadActor(c);
    const session = await requireUploadSession(c.env, actor, {
      sessionId: body.sessionId,
      requireActive: true,
    });

    if (session.uploadId !== body.uploadId) {
      throw new HttpError(409, "upload_session_mismatch", "uploadId does not match upload session.");
    }

    if (body.partNumber > session.maxParts) {
      throw new HttpError(400, "invalid_part_number", "partNumber exceeds allowed max parts.", {
        partNumber: body.partNumber,
        maxParts: session.maxParts,
      });
    }

    if (body.contentLength > R2_MAX_PART_SIZE_BYTES) {
      throw new HttpError(400, "invalid_part_size", "Part size exceeds R2 maximum part size.", {
        contentLength: body.contentLength,
        maxPartSizeBytes: R2_MAX_PART_SIZE_BYTES,
      });
    }

    const expectedParts = expectedPartCount(session.declaredSize, session.partSizeBytes);
    if (body.partNumber > expectedParts) {
      throw new HttpError(400, "invalid_part_number", "partNumber exceeds expected part count for declaredSize.", {
        partNumber: body.partNumber,
        expectedParts,
      });
    }

    if (body.partNumber < expectedParts && body.contentLength !== session.partSizeBytes) {
      throw new HttpError(400, "invalid_part_size", "Non-final part size must equal configured partSizeBytes.", {
        partNumber: body.partNumber,
        expectedPartSizeBytes: session.partSizeBytes,
        contentLength: body.contentLength,
      });
    }

    if (body.partNumber === expectedParts) {
      const remaining = session.declaredSize - session.partSizeBytes * (expectedParts - 1);
      const expectedFinalSize = remaining > 0 ? remaining : session.partSizeBytes;
      if (body.contentLength !== expectedFinalSize) {
        throw new HttpError(400, "invalid_part_size", "Final part size does not match declaredSize.", {
          expectedFinalSize,
          contentLength: body.contentLength,
        });
      }
    }

    const policy = getUploadPolicy(c);
    const signed = await signMultipartUploadPart(c.env, {
      bucketName: session.bucket,
      key: session.stagingKey,
      uploadId: session.uploadId,
      partNumber: body.partNumber,
      expiresInSec: policy.signPartTtlSec,
      contentLength: body.contentLength,
      contentType: session.contentType,
      contentMd5: body.contentMd5,
    });
    await recordUploadSessionSignedPart(c.env, actor, {
      sessionId: session.sessionId,
      uploadId: session.uploadId,
      partNumber: body.partNumber,
      contentLength: body.contentLength,
      contentMd5: body.contentMd5,
    });

    return jsonValidated(uploadSignPartResponseSchema, {
      sessionId: session.sessionId,
      uploadId: session.uploadId,
      partNumber: body.partNumber,
      url: signed.url,
      method: signed.method,
      headers: signed.headers,
      expiresAt: signed.expiresAt,
    });
  });

  app.post("/api/v2/upload/complete", async (c) => {
    const body = readJsonBody(c, uploadCompleteBodySchema);
    const actor = requireUploadActor(c);
    // requireActive is false here because a completed session must replay its
    // original success payload (idempotent retry) and a staged session must
    // resume promotion, rather than both being rejected with a bare 409.
    // let: reassigned once the promotion lease is acquired, below.
    let session = await requireUploadSession(c.env, actor, {
      sessionId: body.sessionId,
      requireActive: false,
    });

    if (session.uploadId !== body.uploadId) {
      throw new HttpError(409, "upload_session_mismatch", "uploadId does not match upload session.");
    }

    if (session.status === "completed") {
      const completedObject = await headObject(c.env.FILES_BUCKET, session.objectKey);
      if (!completedObject) {
        throw new HttpError(
          500,
          "upload_completed_object_missing",
          `Session ${session.sessionId} is marked completed but object ${session.objectKey} is missing.`,
        );
      }
      return jsonValidated(uploadCompleteResponseSchema, {
        key: session.objectKey,
        etag: completedObject.etag,
        uploaded: completedObject.uploaded ? completedObject.uploaded.toISOString() : null,
        size: completedObject.size,
        // Reflect what the object actually stores, not the placeholder
        // declaration: the first response may have reported a magic-byte
        // detected type that differs from session.contentType (see below).
        contentType: completedObject.httpMetadata?.contentType ?? session.contentType,
        originalFilename: session.filename,
      });
    }

    if (session.status !== "active" && session.status !== "staged") {
      throw new HttpError(409, "upload_session_not_active", "Upload session is not active.", {
        status: session.status,
      });
    }

    const overwriteRequested = session.overwrite === true || body.overwrite === true;
    let stagedSize: number;

    // Records completion (the store deletes the staged object once that is
    // durable) and builds the response. Reads `session` at call time so the
    // lease token acquired below reaches the store.
    const recordCompletion = async (finalObject: R2Object, contentType: string): Promise<Response> => {
      await markUploadSessionCompleted(c.env, actor, leasePayload(session));
      return jsonValidated(uploadCompleteResponseSchema, {
        key: session.objectKey,
        etag: finalObject.etag,
        uploaded: finalObject.uploaded ? finalObject.uploaded.toISOString() : null,
        size: finalObject.size,
        contentType,
        originalFilename: session.filename,
      });
    };

    if (session.status === "active") {
      validateCompleteParts(body.parts, session.maxParts);

      const expectedParts = expectedPartCount(session.declaredSize, session.partSizeBytes);
      if (body.parts.length !== expectedParts) {
        throw new HttpError(400, "invalid_part_count", "Part count does not match declaredSize.", {
          expectedParts,
          receivedParts: body.parts.length,
        });
      }

      // Before assembling anything, fail fast on a conflicting target key so
      // the multipart upload stays intact for a retry with overwrite or an
      // abort, instead of consuming the uploadId just to reject afterward.
      if (session.stagingKey !== session.objectKey && !overwriteRequested) {
        const existing = await headObject(c.env.FILES_BUCKET, session.objectKey);
        if (existing) {
          throw new HttpError(409, "object_exists", "An object already exists at the target key.", {
            key: session.objectKey,
          });
        }
      }

      // Assemble the upload at the staging key. Every validation below runs
      // against the staged object; the final target key is only written after
      // all checks pass, so rejected uploads cannot destroy an existing object.
      try {
        const stagedObject = await completeMultipartUpload(
          c.env.FILES_BUCKET,
          session.stagingKey,
          session.uploadId,
          body.parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
        );
        stagedSize = stagedObject.size;
      } catch (error) {
        // completeMultipartUpload can throw for a session still recorded as
        // "active" when a previous attempt already consumed the uploadId (R2
        // finalized it) but crashed before this request's own write below
        // landed: for example a duplicate request that lost the race inside
        // R2, or a Worker eviction between R2 confirming completion and the
        // next storage write. Check reality before treating this as fatal.
        const staged = await headObject(c.env.FILES_BUCKET, session.stagingKey);
        if (!staged || staged.size !== session.declaredSize) {
          throw new HttpError(
            500,
            "upload_completion_failed",
            `Failed to complete multipart upload for session ${session.sessionId}: ` +
              `${error instanceof Error ? error.message : String(error)}.`,
          );
        }
        stagedSize = staged.size;
      }
    } else {
      // status === "staged": R2-side assembly already finished on a prior
      // attempt that failed before or during promotion. Resume from the
      // staged object instead of re-running completion.
      const staged = await headObject(c.env.FILES_BUCKET, session.stagingKey);
      if (!staged) {
        // The store deletes the staged object only after recording
        // completion, so its absence here means either a leftover from a
        // release without that ordering or a hand-deleted object. The prior
        // attempt may still have promoted it: check the target for this
        // session's own bytes, under the lease so a promoter that is still
        // running for this session is waited out rather than raced.
        session = await acquirePromotionLease(c.env, actor, leasePayload(session));
        const promoted = await headObject(c.env.FILES_BUCKET, session.objectKey);
        if (promoted && promotedBySession(promoted, session.sessionId)) {
          return await recordCompletion(promoted, promoted.httpMetadata?.contentType ?? session.contentType);
        }
        await releasePromotionLease(c.env, actor, leasePayload(session)).catch((releaseError) => {
          console.error(`Failed to release promotion lease for session ${session.sessionId}:`, releaseError);
        });
        throw new HttpError(
          410,
          "upload_staged_object_missing",
          `Staged object ${session.stagingKey} for session ${session.sessionId} is missing.`,
        );
      }
      stagedSize = staged.size;
    }

    if (session.maxFileBytes > 0 && stagedSize > session.maxFileBytes) {
      await rejectStagedUpload(
        c.env,
        actor,
        session,
        new HttpError(413, "upload_size_limit", "Completed upload exceeds configured maximum file size.", {
          size: stagedSize,
          maxFileBytes: session.maxFileBytes,
        }),
      );
    }

    if (stagedSize !== session.declaredSize) {
      await rejectStagedUpload(
        c.env,
        actor,
        session,
        new HttpError(400, "upload_size_mismatch", "Completed upload size does not match declaredSize.", {
          size: stagedSize,
          declaredSize: session.declaredSize,
        }),
      );
    }

    if (typeof body.finalSize === "number" && stagedSize !== body.finalSize) {
      await rejectStagedUpload(
        c.env,
        actor,
        session,
        new HttpError(400, "upload_final_size_mismatch", "Completed upload size does not match finalSize.", {
          size: stagedSize,
          finalSize: body.finalSize,
        }),
      );
    }

    const policy = getUploadPolicy(c);
    const detectedMime = await uploadedMagicMime(c.env.FILES_BUCKET, session.stagingKey);
    const normalizedContentType = normalizeMimeType(session.contentType);
    if (detectedMime && !magicMimeMatchesDeclared(normalizedContentType, detectedMime)) {
      await rejectStagedUpload(
        c.env,
        actor,
        session,
        new HttpError(400, "upload_magic_mismatch", "Magic-byte type does not match declared Content-Type.", {
          declaredContentType: normalizedContentType,
          detectedMime,
        }),
      );
    }

    // An empty or generic declared Content-Type carries no real signal: once
    // magic bytes confirm a known type, that detected type becomes the
    // effective content type for policy checks and the response instead of
    // the meaningless placeholder.
    const effectiveContentType =
      detectedMime && isGenericOrMissingContentType(normalizedContentType) ? detectedMime : normalizedContentType;

    if (policy.blockedMime.includes(effectiveContentType)) {
      await rejectStagedUpload(
        c.env,
        actor,
        session,
        new HttpError(400, "upload_content_type_blocked", "Declared Content-Type is blocked by server policy.", {
          contentType: effectiveContentType,
          blockedMime: policy.blockedMime,
        }),
      );
    }

    if (detectedMime && policy.blockedMime.includes(detectedMime)) {
      await rejectStagedUpload(
        c.env,
        actor,
        session,
        new HttpError(400, "upload_magic_blocked", "Detected file type is blocked by server policy.", {
          detectedMime,
          blockedMime: policy.blockedMime,
        }),
      );
    }

    if (policy.allowedMime.length > 0 && !policy.allowedMime.includes(effectiveContentType)) {
      await rejectStagedUpload(
        c.env,
        actor,
        session,
        new HttpError(400, "upload_content_type_not_allowed", "Declared Content-Type is not allowed.", {
          contentType: effectiveContentType,
          allowedMime: policy.allowedMime,
        }),
      );
    }

    if (
      detectedMime &&
      policy.allowedMime.length > 0 &&
      !policy.allowedMime.includes(detectedMime) &&
      !(policy.allowedMime.includes(normalizedContentType) && magicMimeMatchesDeclared(normalizedContentType, detectedMime))
    ) {
      await rejectStagedUpload(
        c.env,
        actor,
        session,
        new HttpError(400, "upload_magic_not_allowed", "Detected file type is not allowed.", {
          detectedMime,
          allowedMime: policy.allowedMime,
        }),
      );
    }

    // Legacy sessions (created before staged completion) assembled directly at
    // the target key; for them the staged object is already the final object.
    // Otherwise, immediately before promotion, move any pre-existing object at
    // the target key to .trash/ (same recoverability as delete) when overwrite
    // is allowed; a race that lands a conflicting object here with overwrite
    // not allowed fails the same way the pre-assembly gate above does, leaving
    // the staged upload retryable.
    let finalObject: R2Object;
    let responseContentType = effectiveContentType;
    if (session.stagingKey === session.objectKey) {
      const legacyFinal = await headObject(c.env.FILES_BUCKET, session.objectKey);
      if (!legacyFinal) {
        throw new HttpError(
          500,
          "upload_completed_object_missing",
          `Legacy session ${session.sessionId} completed but object ${session.objectKey} is missing.`,
        );
      }
      finalObject = legacyFinal;
    } else {
      // The staged object's own httpMetadata.contentType is whatever was
      // declared at /init (possibly the generic placeholder); only override
      // it when the magic-mime carve-out above actually resolved something
      // more specific, so a real declaration is never second-guessed.
      const contentTypeOverride: CopyObjectOptions | undefined =
        effectiveContentType !== normalizedContentType ? { httpMetadata: { contentType: effectiveContentType } } : undefined;

      // Acquire the exclusive promotion lease before the existence check and
      // soft delete: a second, concurrent or retried /complete that reaches
      // this point while this attempt is still in flight must not be able to
      // see this attempt's own promoted object as "existing" and soft-delete
      // it out from under this attempt.
      session = await acquirePromotionLease(c.env, actor, leasePayload(session));

      try {
        const existing = await wrapUploadStorageError(
          headObject(c.env.FILES_BUCKET, session.objectKey),
          "upload_promotion_precheck_failed",
          `check whether an object already exists at ${session.objectKey}`,
        );
        if (existing && promotedBySession(existing, session.sessionId)) {
          // A prior attempt promoted this exact session and crashed before
          // recording completion: the target already holds these bytes, so
          // copying again (or treating them as a conflict) is wrong; only
          // the completion record is missing.
          finalObject = existing;
          responseContentType = existing.httpMetadata?.contentType ?? effectiveContentType;
        } else {
          if (existing) {
            if (!overwriteRequested) {
              throw new HttpError(409, "object_exists", "An object already exists at the target key.", {
                key: session.objectKey,
              });
            }
            // Back up without deleting: promoteObject's own write below
            // replaces the target atomically, so a promotion failure after
            // this point leaves the original object exactly as it was (plus a
            // redundant, harmless trash copy) instead of an empty target key.
            await wrapUploadStorageError(
              backupObjectToTrash(c.env.FILES_BUCKET, session.objectKey),
              "upload_overwrite_backup_failed",
              `back up the existing object at ${session.objectKey} to trash before overwrite`,
            );
          }
          finalObject = await wrapUploadStorageError(
            promoteObject(c.env.FILES_BUCKET, session.stagingKey, session.objectKey, undefined, {
              ...contentTypeOverride,
              // Only when overwrite is not allowed: closes the same
              // check-then-act race the head check above cannot, by itself,
              // rule out between that check and this write.
              createOnlyIfAbsent: !overwriteRequested,
              beforeWrite: promotionLeaseRenewer(c.env, actor, session),
            }),
            "upload_promotion_failed",
            `promote staged upload to ${session.objectKey}`,
          );
        }
      } catch (error) {
        // Release immediately so a client that retries right away (or after
        // fixing the conflict, for example with overwrite: true) resumes
        // without waiting out the lease TTL. A stale token makes this a
        // no-op on the store side, so a lease a retry now holds survives.
        await releasePromotionLease(c.env, actor, leasePayload(session)).catch((releaseError) => {
          console.error(`Failed to release promotion lease for session ${session.sessionId}:`, releaseError);
        });
        throw error;
      }
    }

    return await recordCompletion(finalObject, responseContentType);
  });

  app.post("/api/v2/upload/abort", async (c) => {
    const body = readJsonBody(c, uploadAbortBodySchema);
    const actor = requireUploadActor(c);
    const session = await requireUploadSession(c.env, actor, {
      sessionId: body.sessionId,
      requireActive: false,
    });

    if (session.uploadId !== body.uploadId) {
      throw new HttpError(409, "upload_session_mismatch", "uploadId does not match upload session.");
    }

    if (session.status === "completed") {
      throw new HttpError(409, "upload_session_already_completed", "Completed upload sessions cannot be aborted.");
    }

    if (session.status === "aborted") {
      return jsonValidated(simpleOkResponseSchema, { ok: true });
    }

    // markUploadSessionAborted rejects with 409 upload_promotion_in_progress,
    // touching neither R2 nor the session, when a live promotion lease
    // exists. This must run, and succeed, before any R2 mutation below, so a
    // concurrent complete that is mid-promotion cannot have its own staged
    // object deleted out from under it by this abort.
    await markUploadSessionAborted(c.env, actor, {
      sessionId: session.sessionId,
      uploadId: session.uploadId,
    });

    if (session.stagingKey !== session.objectKey) {
      // Check reality rather than the status read above, which can be stale
      // by now: a fast concurrent complete may have finished assembly (and
      // released its lease after a failed promotion) between that read and
      // the abort above succeeding.
      const staged = await headObject(c.env.FILES_BUCKET, session.stagingKey);
      if (staged) {
        await c.env.FILES_BUCKET.delete(session.stagingKey).catch((error) => {
          console.error(`Failed to delete staged object ${session.stagingKey} for session ${session.sessionId}:`, error);
        });
      } else {
        await abortMultipartUpload(c.env.FILES_BUCKET, session.stagingKey, session.uploadId).catch((error) => {
          console.error(`Failed to abort multipart upload ${session.uploadId} for session ${session.sessionId}:`, error);
        });
      }
    } else {
      // Legacy session: stagingKey === objectKey, so only the multipart
      // upload itself may be canceled; the target key might already hold an
      // unrelated pre-existing object this upload was about to overwrite.
      await abortMultipartUpload(c.env.FILES_BUCKET, session.stagingKey, session.uploadId).catch((error) => {
        console.error(`Failed to abort multipart upload ${session.uploadId} for session ${session.sessionId}:`, error);
      });
    }

    return jsonValidated(simpleOkResponseSchema, { ok: true });
  });
}
