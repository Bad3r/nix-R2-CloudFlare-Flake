export interface Env {
  FILES_BUCKET: R2Bucket;
  R2E_SHARES_KV: KVNamespace;
  R2E_KEYS_KV: KVNamespace;
  R2E_ADMIN_AUTH_WINDOW_SEC?: string;
  R2E_MAX_SHARE_TTL_SEC?: string;
  R2E_DEFAULT_SHARE_TTL_SEC?: string;
  R2E_UI_MAX_LIST_LIMIT?: string;
  R2E_PUBLIC_BASE_URL?: string;
  R2E_READONLY?: string;
  R2E_BUCKET_MAP?: string;
  [key: string]: unknown;
}

export interface AccessIdentity {
  email: string | null;
  userId: string | null;
  jwt: string | null;
}

export interface ShareRecord {
  tokenId: string;
  bucket: string;
  key: string;
  createdAt: string;
  expiresAt: string;
  maxDownloads: number;
  downloadCount: number;
  revoked: boolean;
  createdBy: string;
  contentDisposition: "attachment" | "inline";
}

export interface AdminKeyset {
  activeKid: string;
  previousKid: string | null;
  keys: Record<string, string>;
  updatedAt: string;
}

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface RequestActor {
  mode: "access" | "hmac";
  actor: string;
}
