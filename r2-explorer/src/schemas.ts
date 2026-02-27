import { z } from "zod";

const keyString = z.string().min(1, "key is required");
const sha256String = z
  .string()
  .trim()
  .regex(/^(?:[A-Fa-f0-9]{64}|[A-Za-z0-9+/]{43}=)$/u, "sha256 must be a hex-64 or base64-encoded SHA-256 digest.");
const md5String = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9+/]{22}==$/u, "contentMd5 must be base64-encoded MD5.");

export const requestActorSchema = z
  .object({
    mode: z.literal("oauth"),
    actor: z.string().min(1),
  })
  .strict();

export const objectMetadataSchema = z
  .object({
    key: z.string(),
    size: z.number().int().nonnegative(),
    etag: z.string(),
    uploaded: z.string().nullable(),
    storageClass: z.string().nullable(),
  })
  .strict();

export const listQuerySchema = z
  .object({
    prefix: z.string().default(""),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(1000).default(200),
  })
  .strict();

export const listResponseSchema = z
  .object({
    prefix: z.string(),
    cursor: z.string().optional(),
    listComplete: z.boolean(),
    delimitedPrefixes: z.array(z.string()),
    objects: z.array(objectMetadataSchema),
    identity: requestActorSchema,
  })
  .strict();

export const metaQuerySchema = z
  .object({
    key: keyString,
  })
  .strict();

export const metaResponseSchema = z
  .object({
    key: z.string(),
    etag: z.string(),
    size: z.number().int().nonnegative(),
    uploaded: z.string().nullable(),
    storageClass: z.string().nullable(),
    httpEtag: z.string().nullable(),
  })
  .strict();

export const uploadInitBodySchema = z
  .object({
    filename: z.string().min(1).max(255),
    prefix: z.string().optional(),
    declaredSize: z.number().int().positive(),
    contentType: z.string().optional(),
    sha256: sha256String.optional(),
    clientUploadId: z.string().max(128).optional(),
  })
  .strict();

export const uploadInitResponseSchema = z
  .object({
    sessionId: z.string().min(1),
    objectKey: z.string(),
    uploadId: z.string(),
    expiresAt: z.string(),
    partSizeBytes: z.number().int().positive(),
    maxParts: z.number().int().positive(),
    signPartTtlSec: z.number().int().positive(),
    allowedMime: z.array(z.string()),
    allowedExt: z.array(z.string()),
  })
  .strict();

export const uploadSignPartBodySchema = z
  .object({
    sessionId: z.string().min(1),
    uploadId: z.string().min(1),
    partNumber: z.coerce.number().int().positive(),
    contentLength: z.coerce.number().int().positive(),
    contentMd5: md5String.optional(),
  })
  .strict();

export const uploadSignPartResponseSchema = z
  .object({
    sessionId: z.string().min(1),
    uploadId: z.string().min(1),
    partNumber: z.number().int().positive(),
    url: z.string().url(),
    method: z.literal("PUT"),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.string(),
  })
  .strict();

export const uploadCompleteBodySchema = z
  .object({
    sessionId: z.string().min(1),
    uploadId: z.string().min(1),
    finalSize: z.number().int().positive().optional(),
    parts: z
      .array(
        z
          .object({
            partNumber: z.number().int().positive(),
            etag: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const uploadCompleteResponseSchema = z
  .object({
    key: z.string(),
    etag: z.string(),
    uploaded: z.string().nullable(),
    size: z.number().int().nonnegative(),
    contentType: z.string().nullable(),
    originalFilename: z.string(),
  })
  .strict();

export const uploadAbortBodySchema = z
  .object({
    sessionId: z.string().min(1),
    uploadId: z.string().min(1),
  })
  .strict();

export const simpleOkResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

export const objectDeleteBodySchema = z
  .object({
    key: keyString,
  })
  .strict();

export const objectDeleteResponseSchema = z
  .object({
    key: z.string(),
    trashKey: z.string(),
  })
  .strict();

export const objectMoveBodySchema = z
  .object({
    fromKey: keyString,
    toKey: keyString,
  })
  .strict();

export const objectMoveResponseSchema = z
  .object({
    fromKey: z.string(),
    toKey: z.string(),
  })
  .strict();

export const shareCreateBodySchema = z
  .object({
    bucket: z.string().optional(),
    key: keyString,
    ttl: z.union([z.string(), z.number()]).optional(),
    maxDownloads: z.number().int().nonnegative().optional(),
    contentDisposition: z.enum(["attachment", "inline"]).optional(),
  })
  .strict();

export const shareCreateResponseSchema = z
  .object({
    tokenId: z.string(),
    url: z.string().url(),
    expiresAt: z.string(),
    maxDownloads: z.number().int().nonnegative(),
    bucket: z.string(),
    key: z.string(),
  })
  .strict();

export const shareRevokeBodySchema = z
  .object({
    tokenId: z.string().min(1),
  })
  .strict();

export const shareRevokeResponseSchema = z
  .object({
    tokenId: z.string(),
    revoked: z.literal(true),
  })
  .strict();

export const shareRecordSchema = z
  .object({
    tokenId: z.string(),
    bucket: z.string(),
    key: z.string(),
    createdAt: z.string(),
    expiresAt: z.string(),
    maxDownloads: z.number().int().nonnegative(),
    downloadCount: z.number().int().nonnegative(),
    revoked: z.boolean(),
    createdBy: z.string(),
    contentDisposition: z.enum(["attachment", "inline"]),
  })
  .strict();

export const shareListQuerySchema = z
  .object({
    bucket: z.string().default("files"),
    key: keyString,
    limit: z.coerce.number().int().positive().max(500).default(100),
    cursor: z.string().optional(),
  })
  .strict();

export const shareListResponseSchema = z
  .object({
    shares: z.array(shareRecordSchema),
    cursor: z.string().optional(),
    listComplete: z.boolean(),
  })
  .strict();

export const serverInfoResponseSchema = z
  .object({
    version: z.string(),
    auth: z
      .object({
        oauthEnabled: z.boolean(),
        requiredScopes: z
          .object({
            read: z.string().min(1),
            write: z.string().min(1),
            shareManage: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    limits: z
      .object({
        maxShareTtlSec: z.number().int().positive(),
        defaultShareTtlSec: z.number().int().positive(),
        uiMaxListLimit: z.number().int().positive(),
        upload: z
          .object({
            maxFileBytes: z.number().int().nonnegative(),
            maxParts: z.number().int().positive(),
            maxConcurrentPerUser: z.number().int().nonnegative(),
            sessionTtlSec: z.number().int().positive(),
            signPartTtlSec: z.number().int().positive(),
            partSizeBytes: z.number().int().positive(),
            allowedMime: z.array(z.string()),
            blockedMime: z.array(z.string()),
            allowedExtensions: z.array(z.string()),
            blockedExtensions: z.array(z.string()),
            prefixAllowlist: z.array(z.string()),
          })
          .strict(),
      })
      .strict(),
    readonly: z.boolean(),
    bucket: z
      .object({
        alias: z.literal("files"),
        binding: z.literal("FILES_BUCKET"),
      })
      .strict(),
    buckets: z
      .array(
        z
          .object({
            alias: z.string(),
            binding: z.string(),
          })
          .strict(),
      )
      .min(1),
    share: z
      .object({
        mode: z.literal("kv-random-token"),
        kvNamespace: z.literal("R2E_SHARES_KV"),
      })
      .strict(),
    actor: requestActorSchema,
  })
  .strict();
