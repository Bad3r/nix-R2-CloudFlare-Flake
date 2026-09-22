import { HttpError } from "./http";

export async function listObjects(
  bucket: R2Bucket,
  prefix: string,
  cursor: string | undefined,
  limit: number,
): Promise<R2Objects> {
  return bucket.list({
    prefix,
    cursor,
    limit,
    delimiter: "/",
  });
}

export async function headObject(bucket: R2Bucket, key: string): Promise<R2Object | null> {
  return bucket.head(key);
}

export async function getObject(bucket: R2Bucket, key: string): Promise<R2ObjectBody> {
  const object = await bucket.get(key);
  if (!object || object.body === null) {
    throw new HttpError(404, "object_not_found", `Object not found: ${key}`);
  }
  return object;
}

/**
 * Result of getObjectForRead: a body on success, object metadata only on a
 * failed onlyIf, or just the size for an unsatisfiable range. `kind` is the
 * discriminant (status alone does not narrow reliably here since 200/206 and
 * 304/412 each group two literals on the same field).
 */
export type RangedObjectResult =
  | { kind: "ok"; status: 200 | 206; object: R2ObjectBody }
  | { kind: "precondition_failed"; status: 304 | 412; object: R2Object }
  | { kind: "unsatisfiable_range"; status: 416; size: number };

type SingleByteRange = { offset: number; end?: number } | { suffix: number };

/**
 * Parse a single-range `Range: bytes=...` header for a post-hoc satisfiability
 * check. Returns null for anything that is not a single well-formed byte
 * range (absent, multi-range, wrong unit, non-numeric, or inverted bounds);
 * R2 already serves the full object for all of those when Range is passed as
 * Headers, which is the desired fallback for them.
 */
function parseSingleByteRange(value: string): SingleByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const [, startText, endText] = match;
  if (startText === "") {
    if (endText === "") {
      return null;
    }
    const suffix = Number.parseInt(endText, 10);
    return suffix > 0 ? { suffix } : null;
  }
  const offset = Number.parseInt(startText, 10);
  if (endText === "") {
    return { offset };
  }
  const end = Number.parseInt(endText, 10);
  return end >= offset ? { offset, end } : null;
}

function isRangeSatisfiable(range: SingleByteRange, size: number): boolean {
  if ("suffix" in range) {
    return size > 0;
  }
  return range.offset < size;
}

/**
 * Determine whether a failed onlyIf check (R2 returned an object without a
 * body) is a 304 (If-None-Match / If-Modified-Since) or a 412 (If-Match /
 * If-Unmodified-Since). R2 reports only pass/fail, not which header failed,
 * so the 412-class headers are re-checked alone: per RFC 7232 section 6 they
 * are evaluated first, so if that narrower check also fails, this is a 412;
 * otherwise the original failure came from a 304-class header. Mirrors the
 * pattern in Cloudflare's own miniflare public R2 endpoint
 * (packages/miniflare/src/workers/r2/public.worker.ts).
 */
async function resolvePreconditionStatus(bucket: R2Bucket, key: string, requestHeaders: Headers): Promise<304 | 412> {
  const preconditionHeaders = new Headers();
  const ifMatch = requestHeaders.get("if-match");
  const ifUnmodifiedSince = requestHeaders.get("if-unmodified-since");
  if (ifMatch !== null) {
    preconditionHeaders.set("if-match", ifMatch);
  }
  if (ifUnmodifiedSince !== null) {
    preconditionHeaders.set("if-unmodified-since", ifUnmodifiedSince);
  }
  if ([...preconditionHeaders.keys()].length === 0) {
    return 304;
  }
  const recheck = await bucket.get(key, { onlyIf: preconditionHeaders });
  // recheck cannot be null: the outer get() already proved the key exists,
  // and narrowing onlyIf further cannot turn a hit into a miss.
  return recheck && !("body" in recheck) ? 412 : 304;
}

/**
 * Read an object honoring Range and conditional request headers, for
 * /api/v2/download and /api/v2/preview. Pass allowRange: false for a HEAD
 * request: bucket.head() cannot evaluate onlyIf (it takes only a key), so
 * HEAD still calls bucket.get() and the caller discards the body, but never
 * requests a Range slice, since a HEAD response describes the whole
 * resource regardless of Range.
 */
export async function getObjectForRead(
  bucket: R2Bucket,
  key: string,
  requestHeaders: Headers,
  options: { allowRange: boolean },
): Promise<RangedObjectResult> {
  const rangeHeaderValue = options.allowRange ? requestHeaders.get("range") : null;
  const object = await bucket.get(key, {
    onlyIf: requestHeaders,
    range: rangeHeaderValue ? requestHeaders : undefined,
  });
  if (!object) {
    throw new HttpError(404, "object_not_found", `Object not found: ${key}`);
  }
  if (!("body" in object)) {
    const status = await resolvePreconditionStatus(bucket, key, requestHeaders);
    return { kind: "precondition_failed", status, object };
  }
  // The real binding always populates object.range (offset 0, full length for
  // a plain read) and serves the full object for an unsatisfiable, multi, or
  // malformed Range, so the status must come from the parsed request header.
  const requested = rangeHeaderValue ? parseSingleByteRange(rangeHeaderValue) : null;
  if (requested && !isRangeSatisfiable(requested, object.size)) {
    await object.body.cancel();
    return { kind: "unsatisfiable_range", status: 416, size: object.size };
  }
  return { kind: "ok", status: requested ? 206 : 200, object };
}

export type PromoteObjectLimits = {
  /**
   * Largest source copied with a single bucket.put(). R2 rejects single-request
   * uploads a little under 5 GiB, so the default stays safely below that.
   */
  singlePutLimitBytes: number;
  /**
   * Ranged-read size re-uploaded as one part during a multipart-copy promote.
   * Must satisfy R2's uniform-part rules (>= 5 MiB, all parts but the last the
   * same size); at 128 MiB the 10000-part ceiling allows ~1.2 TiB objects, but
   * only because wrangler.toml raises limits.subrequests (2 subrequests per
   * copy part); at the Workers default (10000) promotion caps out around half that.
   */
  copyPartSizeBytes: number;
};

const DEFAULT_PROMOTE_LIMITS: PromoteObjectLimits = {
  singlePutLimitBytes: 4 * 1024 * 1024 * 1024,
  copyPartSizeBytes: 128 * 1024 * 1024,
};

/** Overrides merged over a copy source's own metadata; only set fields replace the source's. */
export type CopyObjectOptions = {
  httpMetadata?: R2HTTPMetadata;
  /**
   * Fail the copy with 409 object_exists instead of overwriting when toKey
   * already exists at write time. Closes the check-then-act race between an
   * earlier existence check and this copy's own write: on the single-put
   * path this is a conditional put (If-None-Match: *); on the multipart-copy
   * path, which has no conditional complete(), this is a head() re-check
   * immediately before complete(), aborting the upload if the key appeared.
   */
  createOnlyIfAbsent?: boolean;
  /**
   * Awaited immediately before every write to the target (each copied part,
   * the multipart complete, or the single put). A caller holding a lease on
   * the target renews it here and throws when the lease was lost, which
   * aborts the copy before it can land a stale write.
   */
  beforeWrite?: () => Promise<void>;
};

/**
 * Copy an object from fromKey to toKey, preserving metadata: a single put()
 * for sources within limits.singlePutLimitBytes, a ranged multipart copy
 * above it, so callers have no practical size cap. Shared by softDeleteObject,
 * moveObject, and promoteObject, all of which must copy before removing the
 * source; none of them may stream a source above R2's single-put limit
 * through one bucket.put() call. options.httpMetadata is merged over the
 * source's own httpMetadata, so a caller can correct one field (for example
 * contentType) without needing to know the rest of the source's metadata.
 */
async function copyObject(
  bucket: R2Bucket,
  fromKey: string,
  toKey: string,
  limits: PromoteObjectLimits,
  options?: CopyObjectOptions,
): Promise<R2Object> {
  const source = await bucket.head(fromKey);
  if (!source) {
    throw new HttpError(404, "object_not_found", `Object not found: ${fromKey}`);
  }
  const httpMetadata: R2HTTPMetadata | undefined = options?.httpMetadata
    ? { ...source.httpMetadata, ...options.httpMetadata }
    : source.httpMetadata;
  const createOnlyIfAbsent = options?.createOnlyIfAbsent === true;

  const beforeWrite = options?.beforeWrite;

  const stored =
    source.size <= limits.singlePutLimitBytes
      ? await promoteViaSinglePut(
          bucket,
          fromKey,
          toKey,
          httpMetadata,
          source.customMetadata,
          createOnlyIfAbsent,
          beforeWrite,
        )
      : await promoteViaMultipartCopy(
          bucket,
          fromKey,
          toKey,
          source,
          limits.copyPartSizeBytes,
          httpMetadata,
          createOnlyIfAbsent,
          beforeWrite,
        );
  if (!stored) {
    if (createOnlyIfAbsent) {
      throw new HttpError(409, "object_exists", `An object already exists at the target key: ${toKey}`, { key: toKey });
    }
    throw new HttpError(500, "object_copy_failed", `Failed to copy object to key: ${toKey}`);
  }
  return stored;
}

/**
 * Copy key to a fresh, uniquely timestamped .trash/ key without deleting the
 * source: a pure backup, safe to call even if a caller's subsequent write to
 * key fails, since key is never touched here. softDeleteObject below is this
 * plus the delete, kept as the actual delete-with-recovery entry point.
 */
export async function backupObjectToTrash(
  bucket: R2Bucket,
  key: string,
  limits: PromoteObjectLimits = DEFAULT_PROMOTE_LIMITS,
): Promise<{ trashKey: string }> {
  const stamped = new Date().toISOString().replace(/[:]/g, "-");
  const trashKey = `.trash/${stamped}/${key}`;
  await copyObject(bucket, key, trashKey, limits);
  return { trashKey };
}

export async function softDeleteObject(
  bucket: R2Bucket,
  key: string,
  limits: PromoteObjectLimits = DEFAULT_PROMOTE_LIMITS,
): Promise<{ trashKey: string }> {
  const { trashKey } = await backupObjectToTrash(bucket, key, limits);
  await bucket.delete(key);
  return { trashKey };
}

export async function moveObject(
  bucket: R2Bucket,
  fromKey: string,
  toKey: string,
  limits: PromoteObjectLimits = DEFAULT_PROMOTE_LIMITS,
  options?: CopyObjectOptions,
): Promise<void> {
  if (fromKey === toKey) {
    throw new HttpError(400, "invalid_move", "Source and destination keys must be different.");
  }
  await copyObject(bucket, fromKey, toKey, limits, options);
  await bucket.delete(fromKey);
}

/**
 * Promote a validated staged object to its final key, preserving metadata.
 * R2 has no server-side rename, so the copy streams through the Worker via
 * copyObject. The target key is only written on success, so a failed
 * promotion leaves any pre-existing target object untouched. The staged
 * source is deliberately left in place: the upload session store deletes it
 * once completion is recorded, so a crash between this copy and that record
 * leaves a retry something to resume from. options.httpMetadata overrides
 * the staged object's own metadata (see copyObject) for a caller that
 * resolved a more accurate value (for example a magic-byte-detected
 * Content-Type) after the source was staged.
 */
export async function promoteObject(
  bucket: R2Bucket,
  fromKey: string,
  toKey: string,
  limits: PromoteObjectLimits = DEFAULT_PROMOTE_LIMITS,
  options?: CopyObjectOptions,
): Promise<R2Object> {
  return copyObject(bucket, fromKey, toKey, limits, options);
}

async function promoteViaSinglePut(
  bucket: R2Bucket,
  fromKey: string,
  toKey: string,
  httpMetadata: R2HTTPMetadata | undefined,
  customMetadata: Record<string, string> | undefined,
  createOnlyIfAbsent: boolean,
  beforeWrite?: () => Promise<void>,
): Promise<R2Object | null> {
  await beforeWrite?.();
  const object = await getObject(bucket, fromKey);
  if (createOnlyIfAbsent) {
    // Wildcard If-None-Match: R2's conditional put resolves to null instead
    // of throwing when the destination already exists, mirroring the
    // gateway logic in @cloudflare/workers-sdk's miniflare R2 validator.
    return bucket.put(toKey, object.body, {
      httpMetadata,
      customMetadata,
      onlyIf: new Headers({ "if-none-match": "*" }),
    });
  }
  return bucket.put(toKey, object.body, {
    httpMetadata,
    customMetadata,
  });
}

async function promoteViaMultipartCopy(
  bucket: R2Bucket,
  fromKey: string,
  toKey: string,
  source: R2Object,
  partSizeBytes: number,
  httpMetadata: R2HTTPMetadata | undefined,
  createOnlyIfAbsent: boolean,
  beforeWrite?: () => Promise<void>,
): Promise<R2Object | null> {
  const upload = await bucket.createMultipartUpload(toKey, {
    httpMetadata,
    customMetadata: source.customMetadata,
  });
  try {
    const parts: R2UploadedPart[] = [];
    for (let offset = 0; offset < source.size; offset += partSizeBytes) {
      await beforeWrite?.();
      const length = Math.min(partSizeBytes, source.size - offset);
      const chunk = await bucket.get(fromKey, { range: { offset, length } });
      if (!chunk) {
        throw new HttpError(500, "upload_promote_failed", `Staged object vanished during promotion: ${fromKey}`);
      }
      parts.push(await upload.uploadPart(parts.length + 1, chunk.body));
    }
    // The complete() below is the write that makes the target visible, so it
    // gets its own check even when every part passed.
    await beforeWrite?.();
    if (createOnlyIfAbsent) {
      // No conditional complete() exists on R2MultipartUpload, so the
      // closest available guard is a re-check immediately before completing:
      // this cannot make the window zero, but it matches copyObject's other
      // path in refusing a copy that would otherwise silently overwrite a
      // key that appeared during the (much longer, part-by-part) copy.
      const appeared = await bucket.head(toKey);
      if (appeared) {
        await upload.abort();
        return null;
      }
    }
    return await upload.complete(parts);
  } catch (error) {
    // Aborting discards the partial copy; the target key is untouched until
    // complete(). A failed abort only leaks unreferenced parts that R2 expires.
    try {
      await upload.abort();
    } catch (abortError) {
      console.error(`Failed to abort promotion copy for ${toKey}:`, abortError);
    }
    throw error;
  }
}

export async function createMultipartUpload(
  bucket: R2Bucket,
  key: string,
  options?: {
    contentType?: string;
    customMetadata?: Record<string, string>;
  },
): Promise<R2MultipartUpload> {
  return bucket.createMultipartUpload(key, {
    httpMetadata: options?.contentType ? { contentType: options.contentType } : undefined,
    customMetadata: options?.customMetadata,
  });
}

export async function uploadMultipartPart(
  bucket: R2Bucket,
  key: string,
  uploadId: string,
  partNumber: number,
  payload: ArrayBuffer,
): Promise<R2UploadedPart> {
  const upload = bucket.resumeMultipartUpload(key, uploadId);
  return upload.uploadPart(partNumber, payload);
}

export async function completeMultipartUpload(
  bucket: R2Bucket,
  key: string,
  uploadId: string,
  parts: R2UploadedPart[],
): Promise<R2Object> {
  const upload = bucket.resumeMultipartUpload(key, uploadId);
  return upload.complete(parts);
}

export async function abortMultipartUpload(bucket: R2Bucket, key: string, uploadId: string): Promise<void> {
  const upload = bucket.resumeMultipartUpload(key, uploadId);
  await upload.abort();
}
