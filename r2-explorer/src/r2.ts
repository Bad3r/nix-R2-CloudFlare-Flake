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
