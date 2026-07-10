import { HttpError } from "../http";

const ZIP_CONTAINER_MIME_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/java-archive",
  "application/vnd.android.package-archive",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
]);

/** Compare a byte window of `input` at `offset` against the expected bytes. */
export function bytesEqual(input: Uint8Array, expected: number[], offset = 0): boolean {
  if (offset + expected.length > input.length) {
    return false;
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (input[offset + index] !== expected[index]) {
      return false;
    }
  }
  return true;
}

/**
 * Detect a well-known media type from leading magic bytes, or null when the
 * bytes match none of the recognized signatures.
 */
export function detectMagicMime(bytes: Uint8Array): string | null {
  if (bytesEqual(bytes, [0x25, 0x50, 0x44, 0x46])) {
    return "application/pdf";
  }
  if (bytesEqual(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (bytesEqual(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (bytesEqual(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) || bytesEqual(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])) {
    return "image/gif";
  }
  if (bytesEqual(bytes, [0x52, 0x49, 0x46, 0x46]) && bytesEqual(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  if (bytesEqual(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return "application/zip";
  }
  return null;
}

/**
 * Read the leading bytes of an uploaded object and detect its magic-byte
 * media type. Fails with 404 when the object is missing.
 */
export async function uploadedMagicMime(bucket: R2Bucket, key: string): Promise<string | null> {
  const object = await bucket.get(key, {
    range: {
      offset: 0,
      length: 16,
    },
  });
  if (!object || object.body === null) {
    throw new HttpError(404, "object_not_found", `Uploaded object not found for magic-byte validation: ${key}`);
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  return detectMagicMime(bytes);
}

/** True when the media type is a ZIP container format (OOXML, ODF, JAR, ...). */
export function isZipContainerMime(contentType: string): boolean {
  return ZIP_CONTAINER_MIME_TYPES.has(contentType) || contentType.endsWith("+zip");
}

/**
 * True when the detected magic-byte type is consistent with the declared
 * Content-Type, treating ZIP container formats as matching ZIP magic bytes.
 */
export function magicMimeMatchesDeclared(declaredContentType: string, detectedMime: string): boolean {
  if (declaredContentType === detectedMime) {
    return true;
  }
  if (detectedMime === "application/zip" && isZipContainerMime(declaredContentType)) {
    return true;
  }
  return false;
}
