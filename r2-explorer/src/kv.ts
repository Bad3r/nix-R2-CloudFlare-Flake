import { HttpError } from "./http";
import type { ShareRecord } from "./types";

const SHARE_PREFIX = "share:";
const SHARE_INDEX_PREFIX = "share-index:";

export function shareRecordKey(tokenId: string): string {
  return `${SHARE_PREFIX}${tokenId}`;
}

export function shareIndexKey(bucket: string, key: string, tokenId: string): string {
  return `${SHARE_INDEX_PREFIX}${encodeURIComponent(bucket)}:${encodeURIComponent(key)}:${tokenId}`;
}

function shareIndexPrefix(bucket: string, key: string): string {
  return `${SHARE_INDEX_PREFIX}${encodeURIComponent(bucket)}:${encodeURIComponent(key)}:`;
}

export async function putShareRecord(
  kv: KVNamespace,
  record: ShareRecord,
  ttlSeconds: number,
): Promise<void> {
  await kv.put(shareRecordKey(record.tokenId), JSON.stringify(record), { expirationTtl: ttlSeconds });
  await kv.put(shareIndexKey(record.bucket, record.key, record.tokenId), "", { expirationTtl: ttlSeconds });
}

export async function getShareRecord(kv: KVNamespace, tokenId: string): Promise<ShareRecord | null> {
  const payload = await kv.get(shareRecordKey(tokenId));
  if (!payload) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw new HttpError(500, "invalid_share_record", "Stored share record is not valid JSON.", {
      tokenId,
      parseError: String(error),
    });
  }
  const record = parsed as Partial<ShareRecord>;
  if (
    !record ||
    typeof record.tokenId !== "string" ||
    typeof record.bucket !== "string" ||
    typeof record.key !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.expiresAt !== "string" ||
    typeof record.maxDownloads !== "number" ||
    typeof record.downloadCount !== "number" ||
    typeof record.revoked !== "boolean" ||
    typeof record.createdBy !== "string" ||
    (record.contentDisposition !== "attachment" && record.contentDisposition !== "inline")
  ) {
    throw new HttpError(500, "invalid_share_record", "Stored share record schema is invalid.", { tokenId });
  }
  return record as ShareRecord;
}

export async function listSharesForObject(
  kv: KVNamespace,
  bucket: string,
  key: string,
  limit = 100,
  cursor?: string,
): Promise<{ shares: ShareRecord[]; cursor?: string; listComplete: boolean }> {
  const prefix = shareIndexPrefix(bucket, key);
  const listing = await kv.list({ prefix, limit, cursor });
  const shares: ShareRecord[] = [];
  for (const item of listing.keys) {
    const tokenId = item.name.slice(prefix.length);
    if (!tokenId) {
      continue;
    }
    const record = await getShareRecord(kv, tokenId);
    if (record) {
      shares.push(record);
    }
  }
  return {
    shares,
    cursor: listing.list_complete ? undefined : listing.cursor,
    listComplete: listing.list_complete,
  };
}
