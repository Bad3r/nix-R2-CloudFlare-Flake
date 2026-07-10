const BASE62_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Generate a cryptographically random base62 identifier of the given length.
 * Bytes >= 248 are rejected to avoid modulo bias over the 62-symbol alphabet.
 */
export function randomTokenId(length = 22): string {
  let output = "";
  while (output.length < length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= 248) {
        continue;
      }
      output += BASE62_ALPHABET[byte % 62];
      if (output.length >= length) {
        return output;
      }
    }
  }
  return output;
}
