import type { Hono } from "hono";
import type { AppContext } from "../app-context";
import { HttpError } from "../http";
import { guessContentType, normalizeMimeType, normalizeObjectKey } from "../object-response";
import { abortMultipartUpload, completeMultipartUpload, createMultipartUpload, promoteObject } from "../r2";
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
import { magicMimeMatchesDeclared, uploadedMagicMime } from "../upload/magic-mime";
import { extractExtension, getUploadPolicy, normalizeUploadPrefix, R2_MAX_PART_SIZE_BYTES } from "../upload/policy";
import { signMultipartUploadPart } from "../upload-signing";
import {
  createUploadSession,
  markUploadSessionAborted,
  markUploadSessionCompleted,
  recordUploadSessionSignedPart,
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
 * Discard a staged-but-invalid completed upload: delete the staged object,
 * mark the session aborted, and rethrow the validation error. The final
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
  await env.FILES_BUCKET.delete(session.stagingKey);
  await markUploadSessionAborted(env, actor, {
    sessionId: session.sessionId,
    uploadId: session.uploadId,
  }).catch((abortError) => {
    // The staged object is already gone; a failed status transition only
    // leaves the session to expire on its own, so log instead of masking the
    // validation error below.
    console.error(`Failed to mark upload session ${session.sessionId} aborted:`, abortError);
  });
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
    const sessionId = randomTokenId(28);
    const stagingKey = stagingObjectKey(sessionId, key);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + policy.sessionTtlSec * 1000).toISOString();

    const upload = await createMultipartUpload(c.env.FILES_BUCKET, stagingKey, {
      contentType,
      customMetadata: {
        originalFilename: filename,
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
    const session = await requireUploadSession(c.env, actor, {
      sessionId: body.sessionId,
      requireActive: true,
    });

    if (session.uploadId !== body.uploadId) {
      throw new HttpError(409, "upload_session_mismatch", "uploadId does not match upload session.");
    }

    validateCompleteParts(body.parts, session.maxParts);

    const expectedParts = expectedPartCount(session.declaredSize, session.partSizeBytes);
    if (body.parts.length !== expectedParts) {
      throw new HttpError(400, "invalid_part_count", "Part count does not match declaredSize.", {
        expectedParts,
        receivedParts: body.parts.length,
      });
    }

    // Assemble the upload at the staging key. Every validation below runs
    // against the staged object; the final target key is only written after
    // all checks pass, so rejected uploads cannot destroy an existing object.
    const stagedObject = await completeMultipartUpload(
      c.env.FILES_BUCKET,
      session.stagingKey,
      session.uploadId,
      body.parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
    );

    if (session.maxFileBytes > 0 && stagedObject.size > session.maxFileBytes) {
      await rejectStagedUpload(
        c.env,
        actor,
        session,
        new HttpError(413, "upload_size_limit", "Completed upload exceeds configured maximum file size.", {
          size: stagedObject.size,
          maxFileBytes: session.maxFileBytes,
        }),
      );
    }

    if (stagedObject.size !== session.declaredSize) {
      await rejectStagedUpload(
        c.env,
        actor,
        session,
        new HttpError(400, "upload_size_mismatch", "Completed upload size does not match declaredSize.", {
          size: stagedObject.size,
          declaredSize: session.declaredSize,
        }),
      );
    }

    if (typeof body.finalSize === "number" && stagedObject.size !== body.finalSize) {
      await rejectStagedUpload(
        c.env,
        actor,
        session,
        new HttpError(400, "upload_final_size_mismatch", "Completed upload size does not match finalSize.", {
          size: stagedObject.size,
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

    if (policy.blockedMime.includes(normalizedContentType)) {
      await rejectStagedUpload(
        c.env,
        actor,
        session,
        new HttpError(400, "upload_content_type_blocked", "Declared Content-Type is blocked by server policy.", {
          contentType: normalizedContentType,
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

    if (policy.allowedMime.length > 0 && !policy.allowedMime.includes(normalizedContentType)) {
      await rejectStagedUpload(
        c.env,
        actor,
        session,
        new HttpError(400, "upload_content_type_not_allowed", "Declared Content-Type is not allowed.", {
          contentType: normalizedContentType,
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
    const finalObject =
      session.stagingKey === session.objectKey
        ? stagedObject
        : await promoteObject(c.env.FILES_BUCKET, session.stagingKey, session.objectKey);

    await markUploadSessionCompleted(c.env, actor, {
      sessionId: session.sessionId,
      uploadId: session.uploadId,
    });

    return jsonValidated(uploadCompleteResponseSchema, {
      key: session.objectKey,
      etag: finalObject.etag,
      uploaded: finalObject.uploaded ? finalObject.uploaded.toISOString() : null,
      size: finalObject.size,
      contentType: session.contentType,
      originalFilename: session.filename,
    });
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

    await abortMultipartUpload(c.env.FILES_BUCKET, session.stagingKey, session.uploadId);
    await markUploadSessionAborted(c.env, actor, {
      sessionId: session.sessionId,
      uploadId: session.uploadId,
    });
    return jsonValidated(simpleOkResponseSchema, { ok: true });
  });
}
