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

Run both in two terminals: the web dev server proxies `/api` and `/share` to the
local API Worker on port 8787 (see `web/README.md`). `/share/*` works fully
locally. `/api/v2/*` needs a Cloudflare Access JWT that only Cloudflare's edge
issues and there is no local bypass, so authenticated routes answer 401 locally:
exercise them against the deployed preview environment or through
`pnpm run test:api`.

## Runtime routes

API routes (Cloudflare Access protected):

- `GET /api/v2/list`
- `GET /api/v2/meta` (`key` query value must be percent-encoded with
  `encodeURIComponent`; a literal `+` decodes as a space)
- `GET /api/v2/download` (same `key` encoding rule; supports `Range` and the
  `If-Match`/`If-None-Match`/`If-Modified-Since`/`If-Unmodified-Since`
  conditional headers, returning `206`/`304`/`412`/`416` as appropriate;
  `HEAD` returns the same headers with no body)
- `GET /api/v2/preview` (same `key` encoding and Range/conditional support as
  `/api/v2/download`)
- `POST /api/v2/object/delete`
- `POST /api/v2/object/move` (optional `overwrite: boolean` body field,
  default `false`; without it, a move onto an existing key returns
  `409 object_exists` instead of overwriting, enforced at write time so a
  key created after the check still fails safely and leaves the concurrent
  write intact; with `overwrite: true`, a copy of the replaced destination
  object is kept under `.trash/` before the move replaces it)
- `POST /api/v2/upload/init`
- `POST /api/v2/upload/sign-part`
- `POST /api/v2/upload/complete`
- `POST /api/v2/upload/abort`
- `POST /api/v2/share/create`
- `GET /api/v2/share/list`
- `POST /api/v2/share/revoke`
- `GET /api/v2/session/info`

Public token route:

- `GET /share/<token>` (supports `Range` and the same
  `If-Match`/`If-None-Match`/`If-Modified-Since`/`If-Unmodified-Since` conditional headers as
  `/api/v2/download`, returning `206`/`304`/`412`/`416` as appropriate; `HEAD` returns the same
  headers with no body and never consumes a download; a byte-0 `GET` consumes one `maxDownloads`
  slot, a `Range` continuation within 15 minutes of a counted download start does not, and a
  `HEAD`/`304`/`412`/`416` outcome gets that same grace when its own `Range` header describes a
  continuation; revocation and exhaustion are authoritative regardless of KV read staleness,
  including in readonly mode, which only skips writing the count)

## Required API Worker bindings

Set these in `wrangler.toml` (or CI-rendered config):

- `FILES_BUCKET` (R2 bucket binding)
- `R2E_SHARES_KV` (share token state)
- `R2E_UPLOAD_SESSIONS` (Durable Object session state for multipart uploads)
- `R2E_READONLY` (`true` blocks non-GET/HEAD `/api/v2/*`)
- `R2E_BUCKET_MAP` (optional JSON alias map; must include `{"files":"FILES_BUCKET"}`)
- `R2E_ACCESS_TEAM_DOMAIN` (required Access team domain, for example `repo.cloudflareaccess.com`)
- `R2E_ACCESS_AUD` (required Access audience claim(s), comma-separated)
- `R2E_ACCESS_JWKS_URL` (optional; defaults to `https://<team-domain>/cdn-cgi/access/certs`)
- `R2E_ACCESS_REQUIRED_SCOPES` (optional generic scope set)
- `R2E_ACCESS_REQUIRED_SCOPES_READ` (optional read-route scope set; default empty)
- `R2E_ACCESS_REQUIRED_SCOPES_WRITE` (optional write-route scope set; default empty)
- `R2E_ACCESS_REQUIRED_SCOPES_SHARE_MANAGE` (optional share-admin scope set; default empty)
- `R2E_ACCESS_CLOCK_SKEW_SEC` (optional; defaults to `60`)
- `R2E_ACCESS_JWKS_CACHE_TTL_SEC` (optional; defaults to `300`)
- `R2E_UPLOAD_S3_BUCKET` (bucket name used when signing direct multipart part uploads)

Upload policy vars (all optional):

- `R2E_UPLOAD_MAX_FILE_BYTES` (`0` = unlimited, default `0`)
- `R2E_UPLOAD_MAX_PARTS` (`0` = up to R2 platform limit `10000`, default `0`)
- `R2E_UPLOAD_MAX_CONCURRENT_PER_USER` (`0` = unlimited, default `0`)
- `R2E_UPLOAD_SESSION_TTL_SEC` (default `3600`)
- `R2E_UPLOAD_SIGN_TTL_SEC` (default `60`; must cover `R2E_UPLOAD_PART_SIZE_BYTES` at a documented minimum
  throughput of 1 MiB/s, or `/api/v2/upload/init` fails fast with `upload_config_invalid` naming both variables
  and the minimum TTL required)
- `R2E_UPLOAD_PART_SIZE_BYTES` (default `8388608`, must be `5 MiB` to `5 GiB`)
- `R2E_UPLOAD_ALLOWED_MIME` (comma-separated MIME allowlist; empty disables allowlist)
- `R2E_UPLOAD_BLOCKED_MIME` (comma-separated MIME blacklist; always enforced if set)
- `R2E_UPLOAD_ALLOWED_EXT` (comma-separated extension allowlist; empty disables allowlist)
- `R2E_UPLOAD_BLOCKED_EXT` (comma-separated extension blacklist; always enforced if set)
- `R2E_UPLOAD_PREFIX_ALLOWLIST` (comma-separated key prefix allowlist; empty allows all)
- `R2E_UPLOAD_ALLOWED_ORIGINS` (comma-separated Origin allowlist for upload control-plane routes)

Upload semantics:

- Zero-byte files are rejected at `/api/v2/upload/init` with 400 `upload_empty_file`; empty-file upload is out of
  scope. `declaredSize` must be greater than zero.
- `/api/v2/upload/init` and `/api/v2/upload/complete` both accept an optional boolean `overwrite` (default
  `false`). If the final object key already exists and neither request set `overwrite: true`, the request fails
  with 409 `object_exists` (`error.details.key` names the key); at `init` no session or multipart upload is
  created, and at `complete` the session and multipart upload stay intact so the client can retry `complete`
  with `overwrite: true` or call `/api/v2/upload/abort`. When overwrite is allowed and an object exists at the
  target key, a copy of that object is kept under `.trash/` (the same recoverability as delete) before the new
  object replaces it; without overwrite, the replacement is conditional on the target key still being absent at
  write time, so a key created after the check still fails with `object_exists` instead of silently overwriting
  it, and the staged upload stays retryable either way. `init` also refuses a second session for the same target
  key (`409 upload_object_key_in_use`) while an earlier session for it is still active or staged (mid-promotion),
  until that session completes or aborts.
- `/api/v2/upload/complete` is idempotent and resumable: retrying it after a full success replays the original
  response instead of erroring, and retrying it after a promotion failure (for example, hitting the Worker
  subrequest ceiling on a very large file) resumes promotion instead of re-running multipart completion.
- While a promotion attempt is in flight (or its lease has not yet expired), a concurrent or retried
  `/api/v2/upload/complete` gets 409 `upload_promotion_in_progress` with `error.details.retryAfterSeconds`
  instead of racing the in-flight attempt; retry after the advertised delay. `/api/v2/upload/abort` refuses
  with the same code under the same condition, rather than deleting the in-flight attempt's staged object.
- A declared or client-sent Content-Type of empty string or `application/octet-stream` is treated as "no real
  declaration": if the uploaded bytes match a known signature (PDF, PNG, JPEG, GIF, WEBP, ZIP family), that
  detected type is accepted and reported back as the object's `contentType` instead of the placeholder value.
  Blocked/allowed MIME policy is still enforced against the detected type in this case.
- Large-file promotion (copying a completed staged upload to its final key once it exceeds the single-put limit)
  is bounded by R2's own 10000-part multipart upload ceiling at the 128 MiB copy-part size used internally,
  roughly 1.2 TiB. `wrangler.toml`'s `[limits] subrequests` is raised above the Workers Paid plan default so the
  Worker's own subrequest ceiling does not cut in below that R2-imposed ceiling; see the comment there for the
  math.

Required API Worker secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`

## Cloudflare Access auth model

`/api/v2/*` is authenticated in-worker using Cloudflare Access JWTs from either:

- `Cf-Access-Jwt-Assertion` request header
- `CF_Authorization` (or `CF_Authorization_*`) cookie for browser requests

Browser sign-in/sign-out is handled by Access directly:

- Sign in: `/cdn-cgi/access/login`
- Sign out: `/cdn-cgi/access/logout`

`/share/*` remains public and token-constrained. `/api/v2/share/*` stays in the
protected API surface and can require `R2E_ACCESS_REQUIRED_SCOPES_SHARE_MANAGE`
when configured.

CLI machine auth uses Access service-token headers:

- `R2_EXPLORER_ACCESS_CLIENT_ID`
- `R2_EXPLORER_ACCESS_CLIENT_SECRET`

Access policy contract enforced by CI (preview):

- `preview.files.unsigned.sh/api/v2/*`: Access app with `allow` + `Service Auth`, no `bypass`
- `preview.files.unsigned.sh/share/*`: Access app with `bypass`

Production Access policy verification is operator-run and out of CI scope.

## CI smoke credential contract

CI smoke and live integration checks run only against preview.

Required preview keys:

- `CF_PREVIEW_CI_SMOKE_BASE_URL`
- `CF_PREVIEW_CI_SMOKE_BUCKET`
- `CF_PREVIEW_CI_SMOKE_KEY`
- `CF_PREVIEW_CI_SERVICE_TOKEN_CLIENT_ID`
- `CF_PREVIEW_CI_SERVICE_TOKEN_CLIENT_SECRET`

Optional keys:

- `CF_PREVIEW_CI_R2_BIN`
- `CF_PREVIEW_CI_SMOKE_TTL`
- `CF_PREVIEW_CI_SMOKE_RETRIES`
- `CF_PREVIEW_CI_SMOKE_RETRY_DELAY_SEC`
- `CF_PREVIEW_CI_SMOKE_TIMEOUT_SEC`
- `CF_PREVIEW_CI_SMOKE_CONNECT_TIMEOUT_SEC`
- `CF_PREVIEW_CI_SMOKE_SHARE_EXHAUSTION_RETRIES`

Production deploy is CI deploy-only. It does not consume
`CF_PRODUCTION_CI_*` smoke/service-token keys.

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

Preview smoke job verifies post-deploy behavior with:

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
- Auth model:
  - API auth is enforced in-worker via Cloudflare Access JWT validation
  - `preview.files.unsigned.sh/share/*` remains publicly reachable by token
