export interface Env {
  FILES_BUCKET: R2Bucket;
  R2E_SHARES_KV: KVNamespace;
  R2E_UPLOAD_SESSIONS: DurableObjectNamespace;
  R2E_MAX_SHARE_TTL_SEC?: string;
  R2E_DEFAULT_SHARE_TTL_SEC?: string;
  R2E_UI_MAX_LIST_LIMIT?: string;
  R2E_PUBLIC_BASE_URL?: string;
  R2E_READONLY?: string;
  R2E_BUCKET_MAP?: string;
  R2E_IDP_ISSUER?: string;
  R2E_IDP_AUDIENCE?: string;
  R2E_IDP_JWKS_URL?: string;
  R2E_IDP_REQUIRED_SCOPES?: string;
  R2E_IDP_REQUIRED_SCOPES_READ?: string;
  R2E_IDP_REQUIRED_SCOPES_WRITE?: string;
  R2E_IDP_REQUIRED_SCOPES_SHARE_MANAGE?: string;
  R2E_IDP_CLOCK_SKEW_SEC?: string;
  R2E_IDP_JWKS_CACHE_TTL_SEC?: string;
  R2E_UPLOAD_MAX_FILE_BYTES?: string;
  R2E_UPLOAD_MAX_PARTS?: string;
  R2E_UPLOAD_MAX_CONCURRENT_PER_USER?: string;
  R2E_UPLOAD_SESSION_TTL_SEC?: string;
  R2E_UPLOAD_SIGN_TTL_SEC?: string;
  R2E_UPLOAD_PART_SIZE_BYTES?: string;
  R2E_UPLOAD_ALLOWED_MIME?: string;
  R2E_UPLOAD_BLOCKED_MIME?: string;
  R2E_UPLOAD_ALLOWED_EXT?: string;
  R2E_UPLOAD_BLOCKED_EXT?: string;
  R2E_UPLOAD_PREFIX_ALLOWLIST?: string;
  R2E_UPLOAD_ALLOWED_ORIGINS?: string;
  R2E_UPLOAD_S3_BUCKET?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  [key: string]: unknown;
}

export interface AuthIdentity {
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

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface RequestActor {
  mode: "oauth";
  actor: string;
}
