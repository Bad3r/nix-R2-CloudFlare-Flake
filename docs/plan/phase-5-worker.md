# Phase 5: R2-Explorer (Worker)

## R2-Explorer Subflake

The `r2-explorer/` directory is an independent Worker subflake with
contract-first APIs and local test coverage.

Phase 5 implementation includes:

- Hono-based router composition in `r2-explorer/src/app.ts`.
- Zod request/response schemas in `r2-explorer/src/schemas.ts` used across API
  handlers.
- Central middleware layering:
  - Access identity extraction
  - readonly enforcement (`R2E_READONLY=true`)
  - route-level auth (Access-only or Access/HMAC hybrid)
  - structured error responses
- Object operations:
  - list/meta/download/preview
  - multipart upload init/sign-part/complete/abort (control-plane only)
  - direct part upload to R2 S3 endpoint using short-lived signed URLs
  - object move and soft-delete to `.trash/`
- Share lifecycle:
  - create/list/revoke on `/api/share/*`
  - public token download on `/share/<token>`
- Multi-bucket share aliases via `R2E_BUCKET_MAP` (must include `{"files":"FILES_BUCKET"}`).
- KV-backed random share token records (`R2E_SHARES_KV`).
- Admin HMAC keyset + nonce replay tracking (`R2E_KEYS_KV`).
- Runtime capability endpoint: `GET /api/server/info`.
- Worker test suite (`vitest`) covering auth, share lifecycle, replay
  protection, readonly mode, multipart control-plane flow, and server info.

Current API surface:

| Route                        | Purpose                                          |
| ---------------------------- | ------------------------------------------------ |
| `GET /api/list`              | List objects/prefixes                            |
| `GET /api/meta`              | Object metadata                                  |
| `GET /api/download`          | Download with attachment disposition             |
| `GET /api/preview`           | Inline/attachment preview by content type        |
| `POST /api/upload/init`      | Start multipart upload session                   |
| `POST /api/upload/sign-part` | Sign a single multipart part upload URL          |
| `POST /api/upload/complete`  | Complete multipart upload                        |
| `POST /api/upload/abort`     | Abort multipart upload                           |
| `POST /api/object/delete`    | Soft-delete object to `.trash/`                  |
| `POST /api/object/move`      | Move/rename object                               |
| `POST /api/share/create`     | Create share token (Access or HMAC admin auth)   |
| `POST /api/share/revoke`     | Revoke share token (Access or HMAC admin auth)   |
| `GET /api/share/list`        | List share records for key (Access or HMAC auth) |
| `GET /api/server/info`       | Runtime capabilities and effective limits        |
| `GET /share/<token>`         | Public tokenized object access                   |

### Secure Multipart Contract

Control-plane (`/api/upload/*`) and data-plane (direct R2 signed `PUT`) are
strictly separated.

Control-plane contract:

- `POST /api/upload/init` request includes `filename`, `declaredSize`,
  optional `prefix`, optional `contentType`, optional `sha256`.
- `POST /api/upload/init` response includes `sessionId`, `uploadId`,
  `objectKey`, `expiresAt`, `partSizeBytes`, `maxParts`, `signPartTtlSec`,
  `allowedMime`, `allowedExt`.
- `POST /api/upload/sign-part` request includes `sessionId`, `uploadId`,
  `partNumber`, `contentLength`, optional `contentMd5`.
- `POST /api/upload/complete` request includes `sessionId`, `uploadId`,
  `parts`, optional `finalSize`.
- `POST /api/upload/abort` request includes `sessionId`, `uploadId`.

Worker-side security controls:

- Origin + CSRF enforcement on all mutating upload control-plane routes.
- Filename-preserving object keys (`prefix + filename`) with original filename
  also stored as metadata.
- Fail-fast in-flight collision handling: `upload/init` rejects `409` when an
  active session already owns the requested key.
- MIME/extension allowlist + blacklist policy with allow-all defaults unless
  allowlists are configured.
- Post-complete magic-byte validation and policy re-check before final accept.
- Durable Object session state with ownership binding and deterministic state
  transitions (`init|active|completed|aborted|expired`).

### CI/CD Deployment

Stage 5 keeps deployment automation lightweight and local-first. CI hardening
and managed deploy workflows remain in Phase 7.

## Authentication Setup

### Cloudflare Access (Zero Trust)

Configure in Cloudflare dashboard:

1. **Identity Providers** (Zero Trust → Settings → Authentication):
   - GitHub OAuth
   - Email OTP (One-time PIN)
   - Apple Login (if available)

2. **Access Application**:
   - Domain: `files.unsigned.sh`
   - Path policy split:
     - `/*` → **Allow** trusted identities (org/users)
     - `/share/*` → **Bypass** for public token links
     - `/api/share/*` → **Bypass** for HMAC admin share management (CLI)

### Sharing Modes and Constraints

#### Presigned URLs (S3 endpoint only)

Use the `r2 share` CLI for quick sharing. These links are always on the S3 endpoint
(`https://<account_id>.r2.cloudflarestorage.com`) and **do not** pass through the custom
domain or Cloudflare Access.

```bash
# Share file for 24 hours (default)
r2 share documents report.pdf

# Share for 7 days
r2 share documents report.pdf 168h
```

#### Worker Share Links (custom domain)

Use the Worker (R2-Explorer) to mint share tokens and proxy downloads on the custom
domain. Links are served under `https://files.unsigned.sh/share/<token>` and use
KV-backed random token records with expiry/revocation/download-limit checks.

`/api/*` routes require Cloudflare Access identity. CLI-driven Worker share
operations (`r2 share worker ...`) authenticate with admin HMAC headers
validated against `R2E_KEYS_KV`.

Note: in production, `/api/share/*` is commonly configured as an Access
`Bypass` so HMAC share operations work without an Access browser session. In
that configuration, Access does not inject `Cf-Access-Jwt-Assertion` headers on
share-management requests, so the Worker accepts Access identity via the
`CF_Authorization` cookie for logged-in browser sessions.

## Files (Current State)

| File                                  | Purpose                                                   |
| ------------------------------------- | --------------------------------------------------------- |
| `packages/r2-cli.nix`                 | Primary `r2` CLI with presigned + Worker share commands   |
| `r2-explorer/flake.nix`               | Worker subflake tooling/dev shell/deploy helper           |
| `r2-explorer/wrangler.toml`           | Worker bindings + runtime vars (`R2E_*`)                  |
| `r2-explorer/src/index.ts`            | Worker entrypoint                                         |
| `r2-explorer/src/app.ts`              | Hono router, middleware chain, handlers                   |
| `r2-explorer/src/schemas.ts`          | Zod contracts for query/body/response payloads            |
| `r2-explorer/src/auth.ts`             | Access and admin HMAC verification logic                  |
| `r2-explorer/src/kv.ts`               | Share record persistence and listing in KV                |
| `r2-explorer/src/r2.ts`               | R2 object helpers (list/get/move/soft-delete/multipart)   |
| `r2-explorer/src/upload-signing.ts`   | SigV4 presigning for direct multipart `UploadPart` URLs   |
| `r2-explorer/src/upload-sessions.ts`  | Durable Object upload session store and state transitions |
| `r2-explorer/src/ui.ts`               | Embedded dashboard interface                              |
| `r2-explorer/src/version.ts`          | Worker version constant exposed by `/api/server/info`     |
| `r2-explorer/tests/*.spec.ts`         | Worker tests (auth/share/readonly/multipart/server info)  |
| `r2-explorer/tests/helpers/memory.ts` | In-memory R2+KV test harness                              |
| `docs/sharing.md`                     | Sharing modes + Access bypass policy guidance             |

## Verification

### R2-Explorer Deployment

```bash
cd r2-explorer
nix develop
wrangler login
pnpm install
pnpm run check
pnpm test
wrangler deploy

# Verify
curl -I https://files.unsigned.sh
# Should redirect to Cloudflare Access
curl -I https://files.unsigned.sh/share/<token>
# Should return object response when token is valid (public link path)

# Verify API remains Access-protected
curl -I https://files.unsigned.sh/api/list
# Should require Cloudflare Access session

# Verify runtime capability endpoint (with Access session)
curl -s https://files.unsigned.sh/api/server/info | jq .
```

### Multipart verification

```bash
# Access-authenticated control-plane init
curl -sS -X POST https://files.unsigned.sh/api/upload/init \
  -H 'content-type: application/json' \
  -H 'origin: https://files.unsigned.sh' \
  -H 'x-r2e-csrf: 1' \
  -H "CF-Access-Client-Id: ${R2E_SMOKE_ACCESS_CLIENT_ID}" \
  -H "CF-Access-Client-Secret: ${R2E_SMOKE_ACCESS_CLIENT_SECRET}" \
  -d '{"filename":"smoke.bin","prefix":"smoke/","declaredSize":4096,"contentType":"application/octet-stream"}' | jq .

# Negative guard checks
curl -sS -X POST https://files.unsigned.sh/api/upload/init \
  -H 'content-type: application/json' \
  -d '{"filename":"bad.bin","prefix":"smoke/","declaredSize":4096,"contentType":"application/octet-stream"}' | jq .
# Expect error code origin_required / csrf_required depending headers.
```
