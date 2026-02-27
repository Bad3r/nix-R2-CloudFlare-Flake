import { createHash, createSign, generateKeyPairSync, randomBytes, sign as nodeSign } from "node:crypto";
import { afterEach, beforeEach } from "vitest";
import { resetAuthSigningKeyCache, sessionCookieName } from "../../src/auth";
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

type UploadSessionRecord = {
  sessionId: string;
  ownerId: string;
  bucket: string;
  uploadId: string;
  objectKey: string;
  filename: string;
  contentType: string;
  declaredSize: number;
  sha256: string | null;
  prefix: string;
  maxParts: number;
  maxFileBytes: number;
  partSizeBytes: number;
  createdAt: string;
  expiresAt: string;
  status: "init" | "active" | "completed" | "aborted" | "expired";
  completedAt: string | null;
  abortedAt: string | null;
  signedParts: Record<
    string,
    {
      partNumber: number;
      issuedAt: string;
      contentLength: number;
      contentMd5: string | null;
    }
  >;
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

type MemoryDurableObjectId = {
  name: string;
  toString: () => string;
};

function doError(status: number, code: string, message: string, details?: unknown): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message,
        details,
      },
    }),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
    },
  );
}

export class MemoryUploadSessionNamespace {
  private readonly sessionsByOwner = new Map<string, Map<string, UploadSessionRecord>>();

  idFromName(name: string): DurableObjectId {
    return {
      name,
      toString: () => name,
    } as unknown as DurableObjectId;
  }

  get(id: DurableObjectId): DurableObjectStub {
    const owner = ((id as unknown as MemoryDurableObjectId).name ?? String(id)).toLowerCase();
    return {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string"
            ? new URL(input)
            : input instanceof URL
              ? input
              : new URL(input.url);
        if ((init?.method || "GET").toUpperCase() !== "POST") {
          return doError(405, "method_not_allowed", "Only POST is supported.");
        }
        const raw = typeof init?.body === "string" ? init.body : "";
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw || "{}");
        } catch (error) {
          return doError(400, "bad_request", "Request body must be valid JSON.", { cause: String(error) });
        }

        const ownerSessions = this.sessionsByOwner.get(owner) ?? new Map<string, UploadSessionRecord>();
        this.sessionsByOwner.set(owner, ownerSessions);
        const nowMs = Date.now();
        for (const [sessionId, session] of ownerSessions.entries()) {
          if (Date.parse(session.expiresAt) <= nowMs) {
            ownerSessions.set(sessionId, {
              ...session,
              status: "expired",
            });
          }
        }

        const asObject =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        if (!asObject) {
          return doError(400, "validation_error", "Request payload must be a JSON object.");
        }

        if (url.pathname === "/create") {
          const sessionRaw =
            asObject.session && typeof asObject.session === "object" && !Array.isArray(asObject.session)
              ? (asObject.session as UploadSessionRecord)
              : null;
          if (!sessionRaw || typeof sessionRaw.sessionId !== "string" || sessionRaw.sessionId.length === 0) {
            return doError(400, "validation_error", "session.sessionId is required.");
          }
          const maxConcurrentUploads =
            typeof asObject.maxConcurrentUploads === "number" && Number.isInteger(asObject.maxConcurrentUploads)
              ? asObject.maxConcurrentUploads
              : 0;
          if (maxConcurrentUploads > 0) {
            let activeCount = 0;
            for (const value of ownerSessions.values()) {
              if (value.status === "active" && Date.parse(value.expiresAt) > nowMs) {
                activeCount += 1;
              }
            }
            if (activeCount >= maxConcurrentUploads) {
              return doError(429, "upload_concurrency_limit", "Maximum concurrent uploads reached.");
            }
          }
          if (ownerSessions.has(sessionRaw.sessionId)) {
            return doError(409, "upload_session_exists", "Upload session already exists.");
          }
          for (const value of ownerSessions.values()) {
            if (
              value.status === "active" &&
              Date.parse(value.expiresAt) > nowMs &&
              value.objectKey === sessionRaw.objectKey
            ) {
              return doError(409, "upload_object_key_in_use", "An active upload session already targets this key.");
            }
          }
          if (sessionRaw.status !== "init" && sessionRaw.status !== "active") {
            return doError(409, "upload_session_invalid_state", "Upload session must start in init or active state.");
          }
          const activeSession: UploadSessionRecord = {
            ...sessionRaw,
            status: "active",
          };
          ownerSessions.set(sessionRaw.sessionId, activeSession);
          return new Response(JSON.stringify({ session: activeSession }), {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }

        if (url.pathname === "/get") {
          const sessionId = typeof asObject.sessionId === "string" ? asObject.sessionId : "";
          const requireActive = asObject.requireActive === true;
          const session = ownerSessions.get(sessionId);
          if (!session) {
            return doError(404, "upload_session_not_found", "Upload session not found.");
          }
          if (session.status === "expired") {
            return doError(410, "upload_session_expired", "Upload session has expired.");
          }
          if (requireActive && session.status !== "active") {
            return doError(409, "upload_session_not_active", "Upload session is not active.");
          }
          return new Response(JSON.stringify({ session }), {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }

        if (url.pathname === "/record-signed-part") {
          const sessionId = typeof asObject.sessionId === "string" ? asObject.sessionId : "";
          const uploadId = typeof asObject.uploadId === "string" ? asObject.uploadId : "";
          const partNumber =
            typeof asObject.partNumber === "number" && Number.isInteger(asObject.partNumber)
              ? asObject.partNumber
              : 0;
          const contentLength =
            typeof asObject.contentLength === "number" && Number.isInteger(asObject.contentLength)
              ? asObject.contentLength
              : 0;
          const contentMd5 =
            typeof asObject.contentMd5 === "string" && asObject.contentMd5.length > 0 ? asObject.contentMd5 : null;

          const session = ownerSessions.get(sessionId);
          if (!session) {
            return doError(404, "upload_session_not_found", "Upload session not found.");
          }
          if (session.uploadId !== uploadId) {
            return doError(409, "upload_session_mismatch", "Upload session uploadId mismatch.");
          }
          if (session.status !== "active") {
            return doError(409, "upload_session_not_active", "Upload session is not active.");
          }
          if (partNumber <= 0 || contentLength <= 0) {
            return doError(400, "validation_error", "partNumber and contentLength must be positive integers.");
          }

          const updated: UploadSessionRecord = {
            ...session,
            signedParts: {
              ...session.signedParts,
              [String(partNumber)]: {
                partNumber,
                issuedAt: new Date().toISOString(),
                contentLength,
                contentMd5,
              },
            },
          };
          ownerSessions.set(sessionId, updated);
          return new Response(JSON.stringify({ session: updated }), {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }

        if (url.pathname === "/complete" || url.pathname === "/abort") {
          const sessionId = typeof asObject.sessionId === "string" ? asObject.sessionId : "";
          const uploadId = typeof asObject.uploadId === "string" ? asObject.uploadId : "";
          const session = ownerSessions.get(sessionId);
          if (!session) {
            return doError(404, "upload_session_not_found", "Upload session not found.");
          }
          if (session.uploadId !== uploadId) {
            return doError(409, "upload_session_mismatch", "Upload session uploadId mismatch.");
          }
          if (session.status === "expired") {
            return doError(410, "upload_session_expired", "Upload session has expired.");
          }

          if (url.pathname === "/complete") {
            if (session.status !== "active") {
              return doError(409, "upload_session_not_active", "Upload session is not active.");
            }
            const updated: UploadSessionRecord = {
              ...session,
              status: "completed",
              completedAt: new Date().toISOString(),
            };
            ownerSessions.set(sessionId, updated);
            return new Response(JSON.stringify({ session: updated }), {
              status: 200,
              headers: { "content-type": "application/json; charset=utf-8" },
            });
          }

          if (session.status === "completed") {
            return doError(409, "upload_session_already_completed", "Upload session is already completed.");
          }
          if (session.status === "aborted") {
            return new Response(JSON.stringify({ session }), {
              status: 200,
              headers: { "content-type": "application/json; charset=utf-8" },
            });
          }
          const updated: UploadSessionRecord = {
            ...session,
            status: "aborted",
            abortedAt: new Date().toISOString(),
          };
          ownerSessions.set(sessionId, updated);
          return new Response(JSON.stringify({ session: updated }), {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }

        return doError(404, "not_found", "Upload session route not found.");
      },
    } as unknown as DurableObjectStub;
  }
}

export const AUTH_TEST_ISSUER = "https://auth.example.com/api/auth";
export const AUTH_TEST_AUD = "r2-explorer-test";

const ACCESS_TEST_KID = "access-kid-test";
const ACCESS_EDDSA_TEST_KID = "access-kid-test-eddsa";

const ACCESS_PRIMARY_KEYPAIR = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ACCESS_ALTERNATE_KEYPAIR = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ACCESS_EDDSA_PRIMARY_KEYPAIR = generateKeyPairSync("ed25519");
const ACCESS_EDDSA_ALTERNATE_KEYPAIR = generateKeyPairSync("ed25519");

const ACCESS_RS_PUBLIC_JWK: JsonWebKey = {
  ...(ACCESS_PRIMARY_KEYPAIR.publicKey.export({ format: "jwk" }) as JsonWebKey),
  kid: ACCESS_TEST_KID,
  use: "sig",
  alg: "RS256",
};

const ACCESS_EDDSA_PUBLIC_JWK: JsonWebKey = {
  ...(ACCESS_EDDSA_PRIMARY_KEYPAIR.publicKey.export({ format: "jwk" }) as JsonWebKey),
  kid: ACCESS_EDDSA_TEST_KID,
  use: "sig",
  alg: "EdDSA",
};

function base64UrlEncode(value: string | Uint8Array): string {
  const raw = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  return raw
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

type AccessJwtOptions = {
  alg?: "RS256" | "EdDSA";
  email?: string | null;
  sub?: string | null;
  commonName?: string;
  serviceTokenId?: string;
  aud?: string | string[];
  iss?: string;
  scope?: string;
  scp?: string[] | string;
  expiresInSec?: number;
  /** Offset from now for the nbf claim (default: -5). Use a large positive value to test not-yet-valid rejection. */
  nbfOffsetSec?: number;
  headerKid?: string;
  signWithAlternateKey?: boolean;
};

export function createAccessJwt(options: AccessJwtOptions = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const alg = options.alg ?? "RS256";
  const header = {
    alg,
    typ: "JWT",
    kid: options.headerKid ?? (alg === "EdDSA" ? ACCESS_EDDSA_TEST_KID : ACCESS_TEST_KID),
  };
  const payload: Record<string, unknown> = {
    iss: options.iss ?? AUTH_TEST_ISSUER,
    aud: options.aud ?? AUTH_TEST_AUD,
    exp: now + (options.expiresInSec ?? 300),
    iat: now,
    nbf: now + (options.nbfOffsetSec ?? -5),
    scope: options.scope ?? "r2.read r2.write r2.share.manage",
  };
  if (options.scp !== undefined) {
    payload.scp = options.scp;
  }
  const email = options.email === undefined ? "engineer@example.com" : options.email;
  const sub = options.sub === undefined ? "oauth-user-id" : options.sub;
  if (email !== null) {
    payload.email = email;
  }
  if (sub !== null) {
    payload.sub = sub;
  }
  if (options.commonName) {
    payload.common_name = options.commonName;
  }
  if (options.serviceTokenId) {
    payload.service_token_id = options.serviceTokenId;
  }

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  let signature: Uint8Array;
  if (alg === "EdDSA") {
    const signed = nodeSign(
      null,
      Buffer.from(signingInput),
      options.signWithAlternateKey ? ACCESS_EDDSA_ALTERNATE_KEYPAIR.privateKey : ACCESS_EDDSA_PRIMARY_KEYPAIR.privateKey,
    );
    signature = new Uint8Array(signed);
  } else {
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const signed = signer.sign(
      options.signWithAlternateKey ? ACCESS_ALTERNATE_KEYPAIR.privateKey : ACCESS_PRIMARY_KEYPAIR.privateKey,
    );
    signature = new Uint8Array(signed);
  }
  const encodedSignature = base64UrlEncode(signature);
  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

export function installAccessJwksFetchMock(): () => void {
  const originalFetch = globalThis.fetch;
  const jwksUrl = `${AUTH_TEST_ISSUER}/jwks`;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === jwksUrl) {
      return new Response(JSON.stringify({ keys: [ACCESS_RS_PUBLIC_JWK, ACCESS_EDDSA_PUBLIC_JWK] }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }
    return originalFetch(input, init);
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

/**
 * Vitest lifecycle helper: installs the Access JWKS fetch mock before each
 * test and restores + clears the signing key cache after each test.
 * Call once at the top level of a describe() block.
 */
export function useAccessJwksFetchMock(): void {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    restoreFetch = installAccessJwksFetchMock();
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
    resetAuthSigningKeyCache();
  });
}

export function accessHeaders(email = "engineer@example.com", options: AccessJwtOptions = {}): HeadersInit {
  const userId = options.sub === undefined ? "oauth-user-id" : options.sub;
  const resolvedEmail = options.email === undefined ? email : options.email;
  const jwt = createAccessJwt({
    ...options,
    email: resolvedEmail,
    sub: userId,
  });
  return {
    authorization: `Bearer ${jwt}`,
  };
}

export function accessHeadersWithoutJwt(email = "engineer@example.com", userId = "oauth-user-id"): HeadersInit {
  return {
    authorization: `Basic ${Buffer.from(`${email}:${userId}`).toString("base64")}`,
  };
}

export function accessSessionCookie(env: Env, email = "engineer@example.com", options: AccessJwtOptions = {}): string {
  const userId = options.sub === undefined ? "oauth-user-id" : options.sub;
  const resolvedEmail = options.email === undefined ? email : options.email;
  const jwt = createAccessJwt({
    ...options,
    email: resolvedEmail,
    sub: userId,
  });
  return `${sessionCookieName(env)}=${encodeURIComponent(jwt)}`;
}

export async function createTestEnv(): Promise<{
  env: Env;
  bucket: MemoryR2Bucket;
  photosBucket: MemoryR2Bucket;
  sharesKv: MemoryKV;
}> {
  const bucket = new MemoryR2Bucket();
  const photosBucket = new MemoryR2Bucket();
  const sharesKv = new MemoryKV();
  const uploadSessions = new MemoryUploadSessionNamespace();

  const env: Env = {
    FILES_BUCKET: bucket as unknown as R2Bucket,
    PHOTOS_BUCKET: photosBucket as unknown as R2Bucket,
    R2E_SHARES_KV: sharesKv as unknown as KVNamespace,
    R2E_UPLOAD_SESSIONS: uploadSessions as unknown as DurableObjectNamespace,
    R2E_MAX_SHARE_TTL_SEC: "2592000",
    R2E_DEFAULT_SHARE_TTL_SEC: "86400",
    R2E_UI_MAX_LIST_LIMIT: "1000",
    R2E_PUBLIC_BASE_URL: "https://files.example.com",
    R2E_READONLY: "false",
    R2E_BUCKET_MAP: JSON.stringify({
      files: "FILES_BUCKET",
      photos: "PHOTOS_BUCKET",
    }),
    R2E_IDP_ISSUER: AUTH_TEST_ISSUER,
    R2E_IDP_AUDIENCE: AUTH_TEST_AUD,
    R2E_IDP_JWKS_URL: `${AUTH_TEST_ISSUER}/jwks`,
    R2E_IDP_REQUIRED_SCOPES_READ: "r2.read",
    R2E_IDP_REQUIRED_SCOPES_WRITE: "r2.write",
    R2E_IDP_REQUIRED_SCOPES_SHARE_MANAGE: "r2.share.manage",
    R2E_IDP_CLOCK_SKEW_SEC: "60",
    R2E_IDP_JWKS_CACHE_TTL_SEC: "300",
    R2E_WEB_OAUTH_AUTHORIZE_URL: "https://auth.unsigned.sh/api/auth/oauth2/authorize",
    R2E_WEB_OAUTH_TOKEN_URL: "https://auth.unsigned.sh/api/auth/oauth2/token",
    R2E_WEB_OAUTH_CLIENT_ID: "r2-explorer-web",
    R2E_WEB_OAUTH_SCOPE: "r2.read r2.write r2.share.manage",
    R2E_WEB_OAUTH_RESOURCE: "https://files.example.com",
    R2E_WEB_OAUTH_REDIRECT_URI: "https://files.example.com/api/v2/auth/callback",
    R2E_WEB_COOKIE_NAME: "r2e_session",
    R2E_WEB_COOKIE_MAX_AGE_SEC: "3600",
    R2E_UPLOAD_MAX_FILE_BYTES: "0",
    R2E_UPLOAD_MAX_PARTS: "0",
    R2E_UPLOAD_MAX_CONCURRENT_PER_USER: "0",
    R2E_UPLOAD_SESSION_TTL_SEC: "3600",
    R2E_UPLOAD_SIGN_TTL_SEC: "60",
    R2E_UPLOAD_PART_SIZE_BYTES: String(8 * 1024 * 1024),
    R2E_UPLOAD_ALLOWED_MIME: "",
    R2E_UPLOAD_BLOCKED_MIME: "",
    R2E_UPLOAD_ALLOWED_EXT: "",
    R2E_UPLOAD_BLOCKED_EXT: "",
    R2E_UPLOAD_PREFIX_ALLOWLIST: "",
    R2E_UPLOAD_ALLOWED_ORIGINS: "https://files.example.com",
    R2E_UPLOAD_S3_BUCKET: "files-bucket-test",
    CLOUDFLARE_ACCOUNT_ID: "account-id-test",
    S3_ACCESS_KEY_ID: "s3-access-test",
    S3_SECRET_ACCESS_KEY: "s3-secret-test",
  };

  return {
    env,
    bucket,
    photosBucket,
    sharesKv,
  };
}
