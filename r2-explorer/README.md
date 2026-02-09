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
- `R2E_READONLY` (`true` blocks non-GET/HEAD `/api/*`)
- `R2E_BUCKET_MAP` (optional JSON map of bucket alias -> binding name; must include `{"files":"FILES_BUCKET"}`)
- `R2E_ACCESS_TEAM_DOMAIN` (required for Access JWT verification on `/api/*`)
- `R2E_ACCESS_AUD` (required Access app audience claim for `/api/*`)

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

- Host: `files.example.com`
- Path: `/*`
- Policy action: `Allow` (authorized identities)

2. Public share links:

- Host: `files.example.com`
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
- `R2E_SMOKE_BASE_URL`
- `R2E_SMOKE_ADMIN_KID`
- `R2E_SMOKE_ADMIN_SECRET`
- `R2E_SMOKE_BUCKET`
- `R2E_SMOKE_KEY`
- `R2E_SMOKE_ACCESS_CLIENT_ID` (Cloudflare Access service-token client ID for `/api/*`)
- `R2E_SMOKE_ACCESS_CLIENT_SECRET` (Cloudflare Access service-token client secret for `/api/*`)

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

Do not commit concrete binding IDs or bucket names into `wrangler.toml`; keep
them in GitHub Environment variables and render `wrangler.ci.toml` during CI.

Optional smoke tuning environment variables:

- `R2E_SMOKE_TIMEOUT` (seconds, default `60`)
- `R2E_SMOKE_CONNECT_TIMEOUT` (seconds, default `10`)
- `R2E_SMOKE_RETRIES` (non-negative integer, default `0`)
- `R2E_SMOKE_RETRY_DELAY_SEC` (seconds, default `2`)

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
