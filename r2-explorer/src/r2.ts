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

export async function softDeleteObject(bucket: R2Bucket, key: string): Promise<{ trashKey: string }> {
  const object = await getObject(bucket, key);
  const stamped = new Date().toISOString().replace(/[:]/g, "-");
  const trashKey = `.trash/${stamped}/${key}`;

  await bucket.put(trashKey, object.body, {
    httpMetadata: object.httpMetadata,
    customMetadata: object.customMetadata,
  });
  await bucket.delete(key);
  return { trashKey };
}

export async function moveObject(bucket: R2Bucket, fromKey: string, toKey: string): Promise<void> {
  if (fromKey === toKey) {
    throw new HttpError(400, "invalid_move", "Source and destination keys must be different.");
  }
  const object = await getObject(bucket, fromKey);
  await bucket.put(toKey, object.body, {
    httpMetadata: object.httpMetadata,
    customMetadata: object.customMetadata,
  });
  await bucket.delete(fromKey);
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
   * same size); at 128 MiB the 10000-part ceiling allows ~1.2 TiB objects.
   */
  copyPartSizeBytes: number;
};

const DEFAULT_PROMOTE_LIMITS: PromoteObjectLimits = {
  singlePutLimitBytes: 4 * 1024 * 1024 * 1024,
  copyPartSizeBytes: 128 * 1024 * 1024,
};

/**
 * Promote a validated staged object to its final key, preserving metadata,
 * then delete the staged source. R2 has no server-side rename, so the copy
 * streams through the Worker: sources within the single-put limit copy with
 * one put(), larger sources stream through a fresh multipart upload at the
 * target key so promotion has no practical size cap. The target key is only
 * written on success (put or complete), so a failed promotion leaves any
 * pre-existing target object untouched.
 */
export async function promoteObject(
  bucket: R2Bucket,
  fromKey: string,
  toKey: string,
  limits: PromoteObjectLimits = DEFAULT_PROMOTE_LIMITS,
): Promise<R2Object> {
  const source = await bucket.head(fromKey);
  if (!source) {
    throw new HttpError(404, "object_not_found", `Object not found: ${fromKey}`);
  }

  const stored =
    source.size <= limits.singlePutLimitBytes
      ? await promoteViaSinglePut(bucket, fromKey, toKey)
      : await promoteViaMultipartCopy(bucket, fromKey, toKey, source, limits.copyPartSizeBytes);
  if (!stored) {
    throw new HttpError(500, "upload_promote_failed", `Failed to promote staged upload to key: ${toKey}`);
  }
  // The staged copy is redundant once the final key is written. A failed
  // cleanup only leaks a staging object (later removed by session pruning),
  // so log it instead of failing the completed upload.
  try {
    await bucket.delete(fromKey);
  } catch (error) {
    console.error(`Failed to delete staged object ${fromKey} after promotion:`, error);
  }
  return stored;
}

async function promoteViaSinglePut(bucket: R2Bucket, fromKey: string, toKey: string): Promise<R2Object | null> {
  const object = await getObject(bucket, fromKey);
  return bucket.put(toKey, object.body, {
    httpMetadata: object.httpMetadata,
    customMetadata: object.customMetadata,
  });
}

async function promoteViaMultipartCopy(
  bucket: R2Bucket,
  fromKey: string,
  toKey: string,
  source: R2Object,
  partSizeBytes: number,
): Promise<R2Object> {
  const upload = await bucket.createMultipartUpload(toKey, {
    httpMetadata: source.httpMetadata,
    customMetadata: source.customMetadata,
  });
  try {
    const parts: R2UploadedPart[] = [];
    for (let offset = 0; offset < source.size; offset += partSizeBytes) {
      const length = Math.min(partSizeBytes, source.size - offset);
      const chunk = await bucket.get(fromKey, { range: { offset, length } });
      if (!chunk) {
        throw new HttpError(500, "upload_promote_failed", `Staged object vanished during promotion: ${fromKey}`);
      }
      parts.push(await upload.uploadPart(parts.length + 1, chunk.body));
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
