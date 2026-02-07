import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Env } from "../../src/types";

type KVEntry = {
  value: string;
  expiresAt?: number;
};

type StoredObject = {
  key: string;
  bytes: Uint8Array;
  uploaded: Date;
  etag: string;
  httpMetadata?: Record<string, unknown>;
  customMetadata?: Record<string, string>;
};

type MultipartUpload = {
  key: string;
  httpMetadata?: Record<string, unknown>;
  customMetadata?: Record<string, string>;
  parts: Map<number, { etag: string; bytes: Uint8Array }>;
};

function isReadableStreamLike(value: unknown): value is ReadableStream {
  return typeof value === "object" && value !== null && "getReader" in value;
}

async function toBytes(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    return body;
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  if (isReadableStreamLike(body)) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      if (chunk.value) {
        chunks.push(chunk.value);
      }
    }
    return concatBytes(chunks);
  }
  return new Uint8Array();
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function hexDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function kvExpired(entry: KVEntry | undefined): boolean {
  if (!entry?.expiresAt) {
    return false;
  }
  return Date.now() >= entry.expiresAt;
}

export class MemoryKV {
  private readonly store = new Map<string, KVEntry>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry || kvExpired(entry)) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const expiresAt =
      typeof options?.expirationTtl === "number" && options.expirationTtl > 0
        ? Date.now() + options.expirationTtl * 1000
        : undefined;
    this.store.set(key, {
      value,
      expiresAt,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<KVNamespaceListResult<unknown, string>> {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const cursor = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;
    const keys = [...this.store.keys()]
      .filter((name) => name.startsWith(prefix))
      .sort((a, b) => a.localeCompare(b));
    const start = Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
    const slice = keys.slice(start, start + limit);
    const listComplete = start + limit >= keys.length;

    return {
      keys: slice.map((name) => ({ name })),
      list_complete: listComplete,
      cursor: listComplete ? undefined : String(start + limit),
      cacheStatus: null,
    } as KVNamespaceListResult<unknown, string>;
  }
}

export class MemoryR2Bucket {
  private readonly objects = new Map<string, StoredObject>();

  private readonly uploads = new Map<string, MultipartUpload>();

  private toR2Object(object: StoredObject): R2Object {
    return {
      key: object.key,
      version: "1",
      size: object.bytes.byteLength,
      etag: object.etag,
      checksums: {},
      uploaded: object.uploaded,
      httpEtag: object.etag,
      range: undefined,
      storageClass: "Standard",
      ssecKeyMd5: undefined,
      customMetadata: object.customMetadata,
      writeHttpMetadata(headers: Headers): void {
        const contentType = object.httpMetadata?.contentType;
        if (typeof contentType === "string" && contentType.length > 0) {
          headers.set("content-type", contentType);
        }
      },
    } as R2Object;
  }

  private toR2ObjectBody(object: StoredObject): R2ObjectBody {
    const base = this.toR2Object(object);
    return {
      ...base,
      body: object.bytes.slice(),
      bodyUsed: false,
      httpMetadata: object.httpMetadata as R2HTTPMetadata,
      text: async () => new TextDecoder().decode(object.bytes),
      json: async () => JSON.parse(new TextDecoder().decode(object.bytes)),
      arrayBuffer: async () =>
        object.bytes.buffer.slice(
          object.bytes.byteOffset,
          object.bytes.byteOffset + object.bytes.byteLength,
        ),
      blob: async () => new Blob([object.bytes]),
    } as R2ObjectBody;
  }

  async put(
    key: string,
    value: unknown,
    options?: { httpMetadata?: Record<string, unknown>; customMetadata?: Record<string, string> },
  ): Promise<R2Object> {
    const bytes = await toBytes(value);
    const object: StoredObject = {
      key,
      bytes,
      uploaded: new Date(),
      etag: hexDigest(bytes),
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
    };
    this.objects.set(key, object);
    return this.toR2Object(object);
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const object = this.objects.get(key);
    if (!object) {
      return null;
    }
    return this.toR2ObjectBody(object);
  }

  async head(key: string): Promise<R2Object | null> {
    const object = this.objects.get(key);
    if (!object) {
      return null;
    }
    return this.toR2Object(object);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(options?: {
    prefix?: string;
    delimiter?: string;
    limit?: number;
    cursor?: string;
  }): Promise<R2Objects> {
    const prefix = options?.prefix ?? "";
    const delimiter = options?.delimiter ?? "";
    const limit = options?.limit ?? 1000;
    const cursor = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort((a, b) => a.localeCompare(b));

    const objects: R2Object[] = [];
    const delimitedPrefixes = new Set<string>();
    for (const key of keys) {
      const rest = key.slice(prefix.length);
      if (delimiter && rest.includes(delimiter)) {
        const delimiterIndex = rest.indexOf(delimiter);
        delimitedPrefixes.add(prefix + rest.slice(0, delimiterIndex + delimiter.length));
        continue;
      }
      const object = this.objects.get(key);
      if (object) {
        objects.push(this.toR2Object(object));
      }
    }

    const start = Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
    const sliced = objects.slice(start, start + limit);
    const truncated = start + limit < objects.length;
    if (truncated) {
      return {
        objects: sliced,
        delimitedPrefixes: [...delimitedPrefixes],
        truncated: true,
        cursor: String(start + limit),
      };
    }
    return {
      objects: sliced,
      delimitedPrefixes: [...delimitedPrefixes],
      truncated: false,
    };
  }

  async createMultipartUpload(
    key: string,
    options?: { httpMetadata?: Record<string, unknown>; customMetadata?: Record<string, string> },
  ): Promise<R2MultipartUpload> {
    const uploadId = randomBytes(8).toString("hex");
    this.uploads.set(uploadId, {
      key,
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
      parts: new Map(),
    });
    return {
      key,
      uploadId,
    } as R2MultipartUpload;
  }

  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) {
      throw new Error(`Unknown uploadId '${uploadId}' for key '${key}'`);
    }

    return {
      key,
      uploadId,
      uploadPart: async (partNumber: number, value: unknown) => {
        const bytes = await toBytes(value);
        const etag = hexDigest(bytes);
        upload.parts.set(partNumber, { bytes, etag });
        return {
          partNumber,
          etag,
        };
      },
      complete: async (parts: R2UploadedPart[]) => {
        const orderedChunks: Uint8Array[] = [];
        for (const part of parts) {
          const stored = upload.parts.get(part.partNumber);
          if (!stored) {
            throw new Error(`Missing uploaded part ${part.partNumber}`);
          }
          if (stored.etag !== part.etag) {
            throw new Error(`ETag mismatch for part ${part.partNumber}`);
          }
          orderedChunks.push(stored.bytes);
        }

        const merged = concatBytes(orderedChunks);
        const object = await this.put(key, merged, {
          httpMetadata: upload.httpMetadata,
          customMetadata: upload.customMetadata,
        });
        this.uploads.delete(uploadId);
        return object;
      },
      abort: async () => {
        this.uploads.delete(uploadId);
      },
    } as R2MultipartUpload;
  }
}

function canonicalQuery(url: URL): string {
  const entries = [...url.searchParams.entries()].sort(([aKey, aValue], [bKey, bValue]) => {
    if (aKey === bKey) {
      return aValue.localeCompare(bValue);
    }
    return aKey.localeCompare(bKey);
  });
  return entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function accessHeaders(email = "engineer@example.com"): HeadersInit {
  return {
    "cf-access-authenticated-user-email": email,
  };
}

export function signedHeaders(
  request: Request,
  kid: string,
  secret: string,
  rawBody: string,
  timestamp?: number,
  nonce?: string,
): HeadersInit {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const nonceValue = nonce ?? randomBytes(12).toString("hex");
  const url = new URL(request.url);
  const canonicalPayload = `${request.method.toUpperCase()}\n${url.pathname}\n${canonicalQuery(url)}\n${sha256Hex(rawBody)}\n${ts}\n${nonceValue}`;
  const signature = hmacSha256Hex(secret, canonicalPayload);
  return {
    "x-r2e-kid": kid,
    "x-r2e-ts": String(ts),
    "x-r2e-nonce": nonceValue,
    "x-r2e-signature": signature,
  };
}

export async function createTestEnv(): Promise<{
  env: Env;
  bucket: MemoryR2Bucket;
  sharesKv: MemoryKV;
  keysKv: MemoryKV;
  kid: string;
  secret: string;
}> {
  const bucket = new MemoryR2Bucket();
  const sharesKv = new MemoryKV();
  const keysKv = new MemoryKV();
  const kid = "k-test";
  const previousKid = "k-prev";
  const secret = "super-secret";
  await keysKv.put(
    "admin:keyset:active",
    JSON.stringify({
      activeKid: kid,
      previousKid,
      keys: {
        [kid]: secret,
        [previousKid]: "previous-secret",
      },
      updatedAt: "2026-02-07T00:00:00Z",
    }),
  );

  const env: Env = {
    FILES_BUCKET: bucket as unknown as R2Bucket,
    R2E_SHARES_KV: sharesKv as unknown as KVNamespace,
    R2E_KEYS_KV: keysKv as unknown as KVNamespace,
    R2E_ADMIN_AUTH_WINDOW_SEC: "300",
    R2E_MAX_SHARE_TTL_SEC: "2592000",
    R2E_DEFAULT_SHARE_TTL_SEC: "86400",
    R2E_UI_MAX_LIST_LIMIT: "1000",
    R2E_PUBLIC_BASE_URL: "https://files.example.com",
    R2E_READONLY: "false",
  };

  return {
    env,
    bucket,
    sharesKv,
    keysKv,
    kid,
    secret,
  };
}
