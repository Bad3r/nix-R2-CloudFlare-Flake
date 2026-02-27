# R2-Explorer

R2-Explorer now ships as two Cloudflare Workers on the same host:

- API Worker (Hono + Zod): signed upload control plane, object operations, and
  share-token lifecycle.
- Web Worker (Astro + Preact): modern operator console UI that calls
  `/api/v2/*` on the same origin.

## Local workflow

```bash
cd r2-explorer
pnpm install
pnpm run check:api
pnpm run test:api
pnpm -C web run check
pnpm -C web run build
```

API dev server:

```bash
pnpm dev
```

Web UI dev server:

```bash
pnpm dev:web
```

## Runtime routes

API routes (Access-protected except `/share/*` public token URLs):

- `GET /api/v2/list`
- `GET /api/v2/meta`
- `GET /api/v2/download`
- `GET /api/v2/preview`
- `POST /api/v2/object/delete`
- `POST /api/v2/object/move`
- `POST /api/v2/upload/init`
- `POST /api/v2/upload/sign-part`
- `POST /api/v2/upload/complete`
- `POST /api/v2/upload/abort`
- `POST /api/v2/share/create`
- `GET /api/v2/share/list`
- `POST /api/v2/share/revoke`
- `GET /api/v2/session/info`

Public token route:

- `GET /share/<token>`

## Required API Worker bindings

Set these in `wrangler.toml` (or CI-rendered config):

- `FILES_BUCKET` (R2 bucket binding)
- `R2E_SHARES_KV` (share token state)
- `R2E_KEYS_KV` (admin keyset + nonce replay keys)
- `R2E_UPLOAD_SESSIONS` (Durable Object session state for multipart uploads)
- `R2E_READONLY` (`true` blocks non-GET/HEAD `/api/v2/*`)
- `R2E_BUCKET_MAP` (optional JSON alias map; must include `{"files":"FILES_BUCKET"}`)
- `R2E_ACCESS_TEAM_DOMAIN` (required for Access JWT verification on `/api/v2/*`)
- `R2E_ACCESS_AUD` (required Access app audience claim for `/api/v2/*`)
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
- `R2E_UPLOAD_ALLOWED_ORIGINS` (comma-separated Origin allowlist for upload control-plane routes)

Required API Worker secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`

## Access policy model

Recommended policy setup on `files.unsigned.sh`:

1. Protected API app:

- Path: `/api/v2/*`
- Policies:
  - `Allow` for authorized identities
  - `Service Auth` for machine callers (CI/service tokens)

2. Public share links:

- Path: `/share/*`
- Action: `Bypass`

`/api/v2/share/*` stays inside the protected API surface. CLI requests should set
`R2_EXPLORER_ACCESS_CLIENT_ID` and `R2_EXPLORER_ACCESS_CLIENT_SECRET` when no
browser Access session is present. The Worker still validates HMAC signatures
and Access JWTs in-app.

## Deploy

API Worker:

```bash
nix run .#deploy
# or
pnpm exec wrangler deploy
```

Web Worker:

```bash
nix run .#deploy-web
# or
pnpm -C web run build
pnpm exec wrangler deploy --config web/wrangler.toml
```

## Production CSP + analytics policy

Production uses a Cloudflare Response Header Transform Rule to set the web
Worker CSP for `files.unsigned.sh` (excluding `/api/v2/*` and `/share/*`).
The policy source of truth is:

- `r2-explorer/web/config/csp.analytics.production.txt`

The deploy workflow syncs this rule with:

- `scripts/ci/sync-r2-web-csp.sh`

and verifies post-deploy behavior with:

- `scripts/ci/check-r2-web-security.sh`

Workflow-managed CSP rule refs:

- Production: `r2-explorer-web-csp`
- Preview: `r2-explorer-web-csp-preview`

Required workflow variable in GitHub Environments (`preview` and `production`):

- `R2E_CF_ZONE_NAME` (example: `unsigned.sh`)
  - Preview: may be empty for out-of-zone preview hosts; CSP sync/check steps
    are skipped with explicit notices.
  - Production: must be non-empty; deploy fails fast if not set.

Required API token permissions for CSP sync:

- `Zone Rulesets Write`
- `Zone Rulesets Read`

## Preview host routing

Preview deploys are expected on:

- `https://preview.files.unsigned.sh`

Route split:

- Web Worker: `preview.files.unsigned.sh/*`
- API Worker: `preview.files.unsigned.sh/api/v2/*` and
  `preview.files.unsigned.sh/share/*`
- Access app paths:
  - API protected app: `preview.files.unsigned.sh/api/v2/*`
  - Public share bypass app: `preview.files.unsigned.sh/share/*`
