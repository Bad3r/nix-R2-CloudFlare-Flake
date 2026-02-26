# R2-Explorer Worker

## Local workflow

```bash
nix develop
pnpm install
pnpm run check
pnpm test
pnpm run dev
```

## Required Wrangler bindings

Set these in `wrangler.toml`:

- `FILES_BUCKET` (R2 bucket binding)
- `R2E_SHARES_KV` (share token state)
- `R2E_KEYS_KV` (admin keyset + nonce replay keys)
- `R2E_UPLOAD_SESSIONS` (Durable Object session state for multipart uploads)
- `R2E_READONLY` (`true` blocks non-GET/HEAD `/api/*`)
- `R2E_BUCKET_MAP` (optional JSON map of bucket alias -> binding name; must include `{"files":"FILES_BUCKET"}`)
- `R2E_ACCESS_TEAM_DOMAIN` (required for Access JWT verification on `/api/*`)
- `R2E_ACCESS_AUD` (required Access app audience claim for `/api/*`)
- `R2E_UPLOAD_S3_BUCKET` (bucket name used when signing direct multipart part uploads)

Upload policy vars (all optional):

- `R2E_UPLOAD_MAX_FILE_BYTES` (`0` = unlimited, default `0`)
- `R2E_UPLOAD_MAX_PARTS` (`0` = up to R2 platform limit `10000`, default `0`)
- `R2E_UPLOAD_MAX_CONCURRENT_PER_USER` (`0` = unlimited, default `0`)
- `R2E_UPLOAD_SESSION_TTL_SEC` (default `3600`)
- `R2E_UPLOAD_SIGN_TTL_SEC` (default `60`)
- `R2E_UPLOAD_PART_SIZE_BYTES` (default `8388608`, must be `5 MiB` to `5 GiB`)
- `R2E_UPLOAD_ALLOWED_MIME` (comma-separated MIME allowlist; empty disables allowlist)
- `R2E_UPLOAD_BLOCKED_MIME` (comma-separated MIME blacklist; always enforced if set)
- `R2E_UPLOAD_ALLOWED_EXT` (comma-separated extension allowlist; empty disables allowlist)
- `R2E_UPLOAD_BLOCKED_EXT` (comma-separated extension blacklist; always enforced if set)
- `R2E_UPLOAD_PREFIX_ALLOWLIST` (comma-separated key prefix allowlist; empty allows all)
- `R2E_UPLOAD_ALLOWED_ORIGINS` (comma-separated Origin allowlist for upload control-plane routes; empty enforces same-origin only)

Numeric upload policy vars are parsed strictly as base-10 integers. If a
non-empty value is invalid, the Worker fails fast with
`500 upload_config_invalid` instead of silently falling back to defaults.

By default, MIME and extension checks are allow-all. Restrictions apply only
when you set `R2E_UPLOAD_ALLOWED_MIME`, `R2E_UPLOAD_BLOCKED_MIME`,
`R2E_UPLOAD_ALLOWED_EXT`, or `R2E_UPLOAD_BLOCKED_EXT`.

Required Worker secrets for direct multipart signing:

- `CLOUDFLARE_ACCOUNT_ID`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`

## Initialize admin keyset

Create a KV value under key `admin:keyset:active` in `R2E_KEYS_KV`:

```json
{
  "activeKid": "k2026_02",
  "previousKid": "k2026_01",
  "keys": {
    "k2026_02": "replace-with-secret",
    "k2026_01": "replace-with-secret"
  },
  "updatedAt": "2026-02-07T00:00:00Z"
}
```

The Worker expects each key value as plain text. Prefix with `base64:` to load
base64-encoded key material.

## Access policy split for share links

Recommended Cloudflare Access policy setup:

1. Protect the app and API:

- Host: `files.unsigned.sh`
- Path: `/*`
- Policy action: `Allow` (authorized identities)

2. Public share links:

- Host: `files.unsigned.sh`
- Path: `/share/*`
- Policy action: `Bypass`

This preserves Access on `/` and `/api/*` while allowing tokenized public
downloads on `/share/<token>`.

Important: Access policy split does not replace app-layer verification.
`/api/*` requires cryptographic validation of `Cf-Access-Jwt-Assertion`
(issuer, audience, expiration, and signature).

Failure responses for `/api/*` auth:

- missing JWT: `401 access_required`
- invalid JWT signature/claims: `401 access_jwt_invalid`
- missing verifier vars (`R2E_ACCESS_TEAM_DOMAIN` / `R2E_ACCESS_AUD`): `500 access_config_invalid`

## Multipart upload architecture

The Worker now uses control-plane/data-plane separation:

1. `POST /api/upload/init` creates a server-side upload session.
2. `POST /api/upload/sign-part` returns a short-lived signed URL for one part.
3. Browser uploads each part directly to R2 S3 endpoint.
4. `POST /api/upload/complete` finalizes the multipart upload.
5. `POST /api/upload/abort` aborts a failed or cancelled upload.

Contract notes:

- `declaredSize` is required in `POST /api/upload/init`.
- `POST /api/upload/init` returns `objectKey` (not `key`) and `allowedExt`.
- `POST /api/upload/init` fails fast with `409` when another active session
  already targets the same key.
- `POST /api/upload/sign-part` accepts optional `contentMd5`.
- `POST /api/upload/complete` accepts optional `finalSize`.

`POST /api/upload/part` is intentionally removed.

Browser direct uploads require bucket CORS that allows your app origin and
exposes `ETag`. Example:

```json
{
  "rules": [
    {
      "allowed": {
        "origins": ["https://files.unsigned.sh"],
        "methods": ["PUT", "HEAD", "GET"],
        "headers": ["content-type", "content-length", "content-md5"]
      },
      "exposeHeaders": ["ETag"],
      "maxAgeSeconds": 3600
    }
  ]
}
```

## Runtime introspection endpoint

`GET /api/server/info` reports:

- Worker version
- enabled auth modes
- readonly status
- configured limits
- storage/share backend mode

## Deploy

```bash
nix run .#deploy
```

or:

```bash
pnpm run deploy
```

## CI deploy workflow

`.github/workflows/r2-explorer-deploy.yml` provides:

- preview deploys on same-repo PRs affecting `r2-explorer/**`
- production deploys via `workflow_dispatch` only (`ref` must be `main`)

Required GitHub Environments:

- `preview`
- `production`

Required environment secrets in both environments:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `R2E_SMOKE_BASE_URL`
- `R2E_SMOKE_ADMIN_KID`
- `R2E_SMOKE_ADMIN_SECRET`
- `R2E_SMOKE_BUCKET`
- `R2E_SMOKE_KEY`
- `R2E_SMOKE_ACCESS_CLIENT_ID` (Cloudflare Access service-token client ID for `/api/*`)
- `R2E_SMOKE_ACCESS_CLIENT_SECRET` (Cloudflare Access service-token client secret for `/api/*`)

Deploy workflow behavior:

- Before each preview/production deploy, CI syncs runtime Worker secret bindings
  with `wrangler secret put` for:
  - `CLOUDFLARE_ACCOUNT_ID`
  - `S3_ACCESS_KEY_ID`
  - `S3_SECRET_ACCESS_KEY`
- Before each preview/production deploy, CI syncs R2 bucket CORS for multipart
  direct uploads via `wrangler r2 bucket cors set`:
  - includes the deploy host origin (`R2E_SMOKE_BASE_URL` for preview,
    `https://files.unsigned.sh` for production)
  - merges any extra origins from `R2E_UPLOAD_ALLOWED_ORIGINS*`
  - enforces `PUT/GET/HEAD`, `content-*` request headers, and exposed `ETag`
- Production deploys fail fast if `R2E_SMOKE_BASE_URL` is not exactly
  `https://files.unsigned.sh`.

Required environment variables in both environments (non-secret binding IDs/names):

- `R2E_FILES_BUCKET`
- `R2E_FILES_BUCKET_PREVIEW`
- `R2E_SHARES_KV_ID`
- `R2E_SHARES_KV_ID_PREVIEW`
- `R2E_KEYS_KV_ID`
- `R2E_KEYS_KV_ID_PREVIEW`
- `R2E_BUCKET_MAP` (optional; JSON alias map. If unset, CI renders a default map from `R2E_FILES_BUCKET*`.)
- `R2E_ACCESS_TEAM_DOMAIN`
- `R2E_ACCESS_TEAM_DOMAIN_PREVIEW`
- `R2E_ACCESS_AUD`
- `R2E_ACCESS_AUD_PREVIEW`
- `R2E_UPLOAD_MAX_FILE_BYTES`
- `R2E_UPLOAD_MAX_FILE_BYTES_PREVIEW` (optional; falls back to non-preview value)
- `R2E_UPLOAD_MAX_PARTS`
- `R2E_UPLOAD_MAX_PARTS_PREVIEW` (optional; falls back to non-preview value)
- `R2E_UPLOAD_MAX_CONCURRENT_PER_USER`
- `R2E_UPLOAD_MAX_CONCURRENT_PER_USER_PREVIEW` (optional; falls back to non-preview value)
- `R2E_UPLOAD_SESSION_TTL_SEC`
- `R2E_UPLOAD_SESSION_TTL_SEC_PREVIEW` (optional; falls back to non-preview value)
- `R2E_UPLOAD_SIGN_TTL_SEC`
- `R2E_UPLOAD_SIGN_TTL_SEC_PREVIEW` (optional; falls back to non-preview value)
- `R2E_UPLOAD_PART_SIZE_BYTES`
- `R2E_UPLOAD_PART_SIZE_BYTES_PREVIEW` (optional; falls back to non-preview value)
- `R2E_UPLOAD_ALLOWED_MIME`
- `R2E_UPLOAD_ALLOWED_MIME_PREVIEW` (optional; falls back to non-preview value)
- `R2E_UPLOAD_BLOCKED_MIME`
- `R2E_UPLOAD_BLOCKED_MIME_PREVIEW` (optional; falls back to non-preview value)
- `R2E_UPLOAD_ALLOWED_EXT`
- `R2E_UPLOAD_ALLOWED_EXT_PREVIEW` (optional; falls back to non-preview value)
- `R2E_UPLOAD_BLOCKED_EXT`
- `R2E_UPLOAD_BLOCKED_EXT_PREVIEW` (optional; falls back to non-preview value)
- `R2E_UPLOAD_PREFIX_ALLOWLIST`
- `R2E_UPLOAD_PREFIX_ALLOWLIST_PREVIEW` (optional; falls back to non-preview value)
- `R2E_UPLOAD_ALLOWED_ORIGINS`
- `R2E_UPLOAD_ALLOWED_ORIGINS_PREVIEW` (optional; falls back to non-preview value)
- `R2E_UPLOAD_S3_BUCKET` (optional; defaults to `R2E_FILES_BUCKET`)
- `R2E_UPLOAD_S3_BUCKET_PREVIEW` (optional; defaults to `R2E_FILES_BUCKET_PREVIEW`)

Do not commit concrete binding IDs or bucket names into `wrangler.toml`; keep
them in GitHub Environment variables and render `wrangler.ci.toml` during CI.

Optional smoke tuning environment variables:

- `R2E_SMOKE_TIMEOUT` (seconds, default `60`)
- `R2E_SMOKE_CONNECT_TIMEOUT` (seconds, default `10`)
- `R2E_SMOKE_RETRIES` (non-negative integer, default `0`)
- `R2E_SMOKE_RETRY_DELAY_SEC` (seconds, default `2`)
- `R2E_SMOKE_SHARE_EXHAUSTION_RETRIES` (non-negative integer, default `5`;
  retries second share download when KV propagation delays `410`)

Smoke behavior validated in CI:

- tokenized `/share/*` works and enforces expiry/download limits
- unauthenticated `/api/server/info` is blocked (`302` Access redirect or Worker `401`)
- authenticated `/api/server/info` succeeds (`200`) via service-token headers
- live integration suite (`pnpm run test:live`) runs against deployed Worker (no mocks)

Recommended protection:

- `preview`: use custom branch policies and include `refs/pull/*/merge` so PR
  deploys are allowed
- `production`: require protected branches for deployments
- `production`: require reviewer approval unless operating as a single maintainer
