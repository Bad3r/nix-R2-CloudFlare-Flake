import { createHash, createSign, generateKeyPairSync, randomBytes, sign as nodeSign } from "node:crypto";
import { afterEach, beforeEach } from "vitest";
import { resetAuthSigningKeyCache } from "../../src/auth";
import type { Env } from "../../src/types";
import { UploadSessionDurableObject } from "../../src/upload-sessions";

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

/**
 * Resolve a `Range: bytes=...` header against a known size, mirroring R2's
 * own behavior for the Headers form of R2GetOptions.range: a single
 * satisfiable range slices the object; anything else (absent, unparseable,
 * multi-range, or out of bounds) falls back to serving the full object
 * rather than signaling an error, matching validator.worker.ts in
 * @cloudflare/workers-sdk's miniflare R2 gateway. Returns an exclusive end.
 */
function resolveRangeHeader(value: string | null, size: number): { offset: number; end: number } | null {
  if (!value) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const [, startText, endText] = match;
  if (startText === "" && endText === "") {
    return null;
  }
  if (startText === "") {
    const suffix = Number.parseInt(endText, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return null;
    }
    const clamped = Math.min(suffix, size);
    return clamped > 0 ? { offset: size - clamped, end: size } : null;
  }
  const offset = Number.parseInt(startText, 10);
  if (!Number.isFinite(offset) || offset < 0 || offset >= size) {
    return null;
  }
  if (endText === "") {
    return { offset, end: size };
  }
  const end = Number.parseInt(endText, 10);
  if (!Number.isFinite(end) || end < offset) {
    return null;
  }
  return { offset, end: Math.min(size, end + 1) };
}

function etagListMatches(headerValue: string, etag: string): boolean {
  if (headerValue.trim() === "*") {
    return true;
  }
  return headerValue
    .split(",")
    .map((part) => part.trim().replace(/^W\//, "").replace(/^"|"$/g, ""))
    .includes(etag);
}

/**
 * Evaluate R2Conditional-as-Headers (onlyIf) against a stored object, per
 * RFC 7232 section 6 precedence: If-Match/If-Unmodified-Since gate first
 * (independent of If-None-Match/If-Modified-Since), matching R2's documented
 * "all conditional headers aside from If-Range are supported" contract.
 */
function onlyIfHeadersPass(onlyIf: Headers, object: StoredObject): boolean {
  const ifMatch = onlyIf.get("if-match");
  if (ifMatch !== null && !etagListMatches(ifMatch, object.etag)) {
    return false;
  }
  const ifUnmodifiedSince = onlyIf.get("if-unmodified-since");
  if (ifMatch === null && ifUnmodifiedSince !== null) {
    const since = new Date(ifUnmodifiedSince);
    if (!Number.isNaN(since.getTime()) && object.uploaded.getTime() > since.getTime()) {
      return false;
    }
  }
  const ifNoneMatch = onlyIf.get("if-none-match");
  if (ifNoneMatch !== null && etagListMatches(ifNoneMatch, object.etag)) {
    return false;
  }
  const ifModifiedSince = onlyIf.get("if-modified-since");
  if (ifNoneMatch === null && ifModifiedSince !== null) {
    const since = new Date(ifModifiedSince);
    if (!Number.isNaN(since.getTime()) && object.uploaded.getTime() <= since.getTime()) {
      return false;
    }
  }
  return true;
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

  /** Keys whose most recently read body had cancel() called on it; see wasBodyCancelled. */
  private readonly cancelledBodies = new Set<string>();

  /** Test hook: whether the most recently read body for `key` was cancelled unread. */
  wasBodyCancelled(key: string): boolean {
    return this.cancelledBodies.has(key);
  }

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
      httpMetadata: object.httpMetadata as R2HTTPMetadata,
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
    const key = object.key;
    this.cancelledBodies.delete(key);
    // A real R2ObjectBody.body is a ReadableStream with cancel(); attach an
    // equivalent method to the byte-array double so recordShareDownload's
    // cancelUnconsumedBody can be exercised without a real stream.
    const body = Object.assign(object.bytes.slice(), {
      cancel: async () => {
        this.cancelledBodies.add(key);
      },
    });
    return {
      ...base,
      body,
      bodyUsed: false,
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
    options?: {
      httpMetadata?: Record<string, unknown>;
      customMetadata?: Record<string, string>;
      onlyIf?: Headers;
    },
  ): Promise<R2Object | null> {
    // Mirrors the real binding's create-only-if-absent form (If-None-Match:
    // *): when no object exists yet, any If-None-Match condition trivially
    // passes and the put proceeds below.
    const existing = this.objects.get(key);
    if (existing && options?.onlyIf instanceof Headers && !onlyIfHeadersPass(options.onlyIf, existing)) {
      return null;
    }
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

  async get(
    key: string,
    options?: {
      range?: { offset?: number; length?: number; suffix?: number } | Headers;
      onlyIf?: Headers;
    },
  ): Promise<R2ObjectBody | R2Object | null> {
    const object = this.objects.get(key);
    if (!object) {
      return null;
    }

    if (options?.onlyIf instanceof Headers && !onlyIfHeadersPass(options.onlyIf, object)) {
      // Precondition failed: R2 returns the object's metadata without a body.
      return this.toR2Object(object);
    }

    const total = object.bytes.byteLength;
    // Like the real binding (verified under workerd): every read reports a
    // resolved range with an explicit `suffix: undefined` key, a full read
    // as { offset: 0, length: size }.
    const fullBody = (): R2ObjectBody =>
      ({ ...this.toR2ObjectBody(object), range: { offset: 0, length: total, suffix: undefined } }) as R2ObjectBody;

    const range = options?.range;
    if (!range) {
      return fullBody();
    }

    let offset: number;
    let end: number;
    if (range instanceof Headers) {
      const resolved = resolveRangeHeader(range.get("range"), total);
      if (!resolved) {
        return fullBody();
      }
      ({ offset, end } = resolved);
    } else if (typeof range.suffix === "number") {
      offset = Math.max(0, total - range.suffix);
      end = total;
    } else {
      offset = range.offset ?? 0;
      end = typeof range.length === "number" ? Math.min(total, offset + range.length) : total;
    }
    if (offset < 0 || offset >= total || end <= offset) {
      throw new Error(`Unsatisfiable range for key '${key}': offset ${offset}, end ${end}, size ${total}`);
    }
    const view = this.toR2ObjectBody({ ...object, bytes: object.bytes.slice(offset, end) });
    return {
      ...view,
      size: total,
      range: { offset, length: end - offset, suffix: undefined },
    } as R2ObjectBody;
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
    // Real R2 returns a usable handle from createMultipartUpload, not just ids.
    return this.resumeMultipartUpload(key, uploadId);
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
        // Store directly instead of calling this.put so tests that spy on
        // put() only observe API-level single-put writes, not completions.
        const object: StoredObject = {
          key,
          bytes: merged,
          uploaded: new Date(),
          etag: hexDigest(merged),
          httpMetadata: upload.httpMetadata,
          customMetadata: upload.customMetadata,
        };
        this.objects.set(key, object);
        this.uploads.delete(uploadId);
        return this.toR2Object(object);
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

/**
 * Routes upload-session store calls to a real UploadSessionDurableObject per
 * owner, backed by in-memory storage, so route tests exercise the lease,
 * expiry and completion logic the Worker deploys instead of a
 * re-implementation that can drift from it.
 */
export class MemoryUploadSessionNamespace {
  private readonly objectsByOwner = new Map<string, UploadSessionDurableObject>();

  constructor(private readonly bucket: MemoryR2Bucket) {}

  idFromName(name: string): DurableObjectId {
    return {
      name,
      toString: () => name,
    } as unknown as DurableObjectId;
  }

  get(id: DurableObjectId): DurableObjectStub {
    const owner = ((id as unknown as MemoryDurableObjectId).name ?? String(id)).toLowerCase();
    let durable = this.objectsByOwner.get(owner);
    if (!durable) {
      const { state } = createMemoryDurableObjectState();
      durable = new UploadSessionDurableObject(state, {
        FILES_BUCKET: this.bucket as unknown as R2Bucket,
      } as unknown as Env);
      this.objectsByOwner.set(owner, durable);
    }
    const target = durable;
    return {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        return target.fetch(new Request(url, init));
      },
    } as unknown as DurableObjectStub;
  }
}

/**
 * In-memory stand-in for the ShareCounterDurableObject namespace, mirroring
 * its /consume (start vs. resume-window continuation), read-only /status,
 * and /revoke contract. Every handler runs synchronously between its map
 * reads and writes, mirroring the serialization the real Durable Object
 * input gate provides, so concurrent app.fetch calls observe an atomic
 * counter.
 */
export class MemoryShareCounterNamespace {
  private readonly counts = new Map<string, number>();

  private readonly revokedTokens = new Set<string>();

  private readonly lastStartAtMs = new Map<string, number>();

  /** Every call that actually wrote state (never /status); see writesFor. */
  private readonly writeLog: Array<{ tokenId: string; action: "consume" | "revoke" }> = [];

  idFromName(name: string): DurableObjectId {
    return {
      name,
      toString: () => name,
    } as unknown as DurableObjectId;
  }

  /** Test hook: read the authoritative counter for a token. */
  countFor(tokenId: string): number {
    return this.counts.get(tokenId) ?? 0;
  }

  /** Test hook: the sequence of writing calls (consume/revoke) made for a token; /status never appears. */
  writesFor(tokenId: string): Array<"consume" | "revoke"> {
    return this.writeLog.filter((entry) => entry.tokenId === tokenId).map((entry) => entry.action);
  }

  get(id: DurableObjectId): DurableObjectStub {
    const tokenKey = (id as unknown as MemoryDurableObjectId).name ?? String(id);
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
        const payload =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        if (!payload) {
          return doError(400, "validation_error", "Request payload must be a JSON object.");
        }

        if (url.pathname === "/revoke") {
          this.revokedTokens.add(tokenKey);
          this.writeLog.push({ tokenId: tokenKey, action: "revoke" });
          return new Response(JSON.stringify({ revoked: true }), {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }

        if (url.pathname !== "/consume" && url.pathname !== "/status") {
          return doError(404, "not_found", "Share counter route not found.");
        }

        const maxDownloads =
          typeof payload.maxDownloads === "number" && Number.isInteger(payload.maxDownloads)
            ? payload.maxDownloads
            : 0;
        const expiresAtMs = typeof payload.expiresAtMs === "number" ? payload.expiresAtMs : 0;
        const downloadCount =
          typeof payload.downloadCount === "number" && Number.isInteger(payload.downloadCount)
            ? payload.downloadCount
            : 0;
        const isContinuation = payload.isContinuation === true;
        const resumeWindowMs =
          typeof payload.resumeWindowMs === "number" && Number.isInteger(payload.resumeWindowMs)
            ? payload.resumeWindowMs
            : 0;

        if (url.pathname === "/status") {
          const revoked = this.revokedTokens.has(tokenKey);
          const count = this.counts.get(tokenKey) ?? downloadCount;
          const expired = Date.now() >= expiresAtMs;
          let capExhausted = maxDownloads > 0 && count >= maxDownloads;
          if (capExhausted && isContinuation) {
            const lastStart = this.lastStartAtMs.get(tokenKey);
            if (typeof lastStart === "number" && Date.now() - lastStart <= resumeWindowMs) {
              capExhausted = false;
            }
          }
          return new Response(JSON.stringify({ revoked, exhausted: expired || capExhausted, count }), {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }

        if (this.revokedTokens.has(tokenKey)) {
          return doError(410, "share_expired", "Share token is expired, revoked, or exhausted.");
        }
        if (Date.now() >= expiresAtMs) {
          return doError(410, "share_expired", "Share token is expired, revoked, or exhausted.");
        }

        const currentCount = this.counts.get(tokenKey) ?? downloadCount;

        if (isContinuation) {
          const lastStart = this.lastStartAtMs.get(tokenKey);
          if (typeof lastStart === "number" && Date.now() - lastStart <= resumeWindowMs) {
            return new Response(JSON.stringify({ count: currentCount, consumed: false }), {
              status: 200,
              headers: { "content-type": "application/json; charset=utf-8" },
            });
          }
          // No recorded start, or it aged out of the window: fall through and
          // treat this range request exactly like a fresh download start.
        }

        if (maxDownloads > 0 && currentCount >= maxDownloads) {
          return doError(410, "share_expired", "Share token is expired, revoked, or exhausted.");
        }
        const updated = currentCount + 1;
        this.counts.set(tokenKey, updated);
        this.lastStartAtMs.set(tokenKey, Date.now());
        this.writeLog.push({ tokenId: tokenKey, action: "consume" });
        return new Response(JSON.stringify({ count: updated, consumed: true }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      },
    } as unknown as DurableObjectStub;
  }
}

/**
 * Minimal in-memory DurableObjectStorage implementation for unit-testing the
 * real Durable Object classes (UploadSessionDurableObject and
 * ShareCounterDurableObject) without miniflare.
 */
export class MemoryDurableObjectStorage {
  private readonly entries = new Map<string, unknown>();

  private alarmTime: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.entries.get(key) as T | undefined;
  }

  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.entries.set(keyOrEntries, value);
      return;
    }
    for (const [key, entryValue] of Object.entries(keyOrEntries)) {
      this.entries.set(key, entryValue);
    }
  }

  async delete(keys: string | string[]): Promise<boolean | number> {
    if (typeof keys === "string") {
      return this.entries.delete(keys);
    }
    let deleted = 0;
    for (const key of keys) {
      if (this.entries.delete(key)) {
        deleted += 1;
      }
    }
    return deleted;
  }

  async deleteAll(): Promise<void> {
    this.entries.clear();
    this.alarmTime = null;
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const prefix = options?.prefix ?? "";
    const result = new Map<string, T>();
    const keys = [...this.entries.keys()].filter((key) => key.startsWith(prefix)).sort((a, b) => a.localeCompare(b));
    for (const key of keys) {
      result.set(key, this.entries.get(key) as T);
    }
    return result;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmTime;
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarmTime = typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime();
  }

  async deleteAlarm(): Promise<void> {
    this.alarmTime = null;
  }
}

/** Build a DurableObjectState stub around MemoryDurableObjectStorage. */
export function createMemoryDurableObjectState(): {
  state: DurableObjectState;
  storage: MemoryDurableObjectStorage;
} {
  const storage = new MemoryDurableObjectStorage();
  const state = {
    storage,
    waitUntil: () => undefined,
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>): Promise<T> => callback(),
  } as unknown as DurableObjectState;
  return { state, storage };
}

export const AUTH_TEST_TEAM_DOMAIN = "repo.cloudflareaccess.com";
export const AUTH_TEST_ISSUER = `https://${AUTH_TEST_TEAM_DOMAIN}`;
export const AUTH_TEST_AUD = "4e6af42fbb5a5c49daa17742abca157c30bac4f734855b695f02e1c4ae849769";

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

/** The default JWKS key set served by installAccessJwksFetchMock, for tests building their own fetch mock. */
export function accessJwksKeys(): JsonWebKey[] {
  return [ACCESS_RS_PUBLIC_JWK, ACCESS_EDDSA_PUBLIC_JWK];
}

/**
 * A JWK for the alternate RSA test keypair under a caller-chosen kid, paired
 * with `createAccessJwt({ signWithAlternateKey: true, headerKid })`. Used to
 * simulate an Access JWKS key rotation: a new kid appearing in the served
 * key set, signed with a key the initial JWKS fetch did not include.
 */
export function alternateAccessPublicJwk(kid: string): JsonWebKey {
  return {
    ...(ACCESS_ALTERNATE_KEYPAIR.publicKey.export({ format: "jwk" }) as JsonWebKey),
    kid,
    use: "sig",
    alg: "RS256",
  };
}

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
  const sub = options.sub === undefined ? "access-user-id" : options.sub;
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
  const jwksUrl = `${AUTH_TEST_ISSUER}/cdn-cgi/access/certs`;

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
  const userId = options.sub === undefined ? "access-user-id" : options.sub;
  const resolvedEmail = options.email === undefined ? email : options.email;
  const jwt = createAccessJwt({
    ...options,
    email: resolvedEmail,
    sub: userId,
  });
  return {
    "cf-access-jwt-assertion": jwt,
  };
}

export function accessHeadersWithoutJwt(): HeadersInit {
  return {
    "cf-access-jwt-assertion": "",
  };
}

export function accessSessionCookie(email = "engineer@example.com", options: AccessJwtOptions = {}): string {
  const userId = options.sub === undefined ? "access-user-id" : options.sub;
  const resolvedEmail = options.email === undefined ? email : options.email;
  const jwt = createAccessJwt({
    ...options,
    email: resolvedEmail,
    sub: userId,
  });
  return `CF_Authorization=${encodeURIComponent(jwt)}`;
}

export async function createTestEnv(): Promise<{
  env: Env;
  bucket: MemoryR2Bucket;
  photosBucket: MemoryR2Bucket;
  sharesKv: MemoryKV;
  shareCounters: MemoryShareCounterNamespace;
}> {
  const bucket = new MemoryR2Bucket();
  const photosBucket = new MemoryR2Bucket();
  const sharesKv = new MemoryKV();
  const uploadSessions = new MemoryUploadSessionNamespace(bucket);
  const shareCounters = new MemoryShareCounterNamespace();

  const env: Env = {
    FILES_BUCKET: bucket as unknown as R2Bucket,
    PHOTOS_BUCKET: photosBucket as unknown as R2Bucket,
    R2E_SHARES_KV: sharesKv as unknown as KVNamespace,
    R2E_UPLOAD_SESSIONS: uploadSessions as unknown as DurableObjectNamespace,
    R2E_SHARE_COUNTERS: shareCounters as unknown as DurableObjectNamespace,
    R2E_MAX_SHARE_TTL_SEC: "2592000",
    R2E_DEFAULT_SHARE_TTL_SEC: "86400",
    R2E_UI_MAX_LIST_LIMIT: "1000",
    R2E_PUBLIC_BASE_URL: "https://files.example.com",
    R2E_READONLY: "false",
    R2E_BUCKET_MAP: JSON.stringify({
      files: "FILES_BUCKET",
      photos: "PHOTOS_BUCKET",
    }),
    R2E_ACCESS_TEAM_DOMAIN: AUTH_TEST_TEAM_DOMAIN,
    R2E_ACCESS_AUD: AUTH_TEST_AUD,
    R2E_ACCESS_JWKS_URL: `${AUTH_TEST_ISSUER}/cdn-cgi/access/certs`,
    R2E_ACCESS_REQUIRED_SCOPES_READ: "",
    R2E_ACCESS_REQUIRED_SCOPES_WRITE: "",
    R2E_ACCESS_REQUIRED_SCOPES_SHARE_MANAGE: "",
    R2E_ACCESS_CLOCK_SKEW_SEC: "60",
    R2E_ACCESS_JWKS_CACHE_TTL_SEC: "300",
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
    shareCounters,
  };
}
