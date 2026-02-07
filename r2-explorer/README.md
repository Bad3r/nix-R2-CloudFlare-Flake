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

`r2-explorer/.github/workflows/deploy.yml` provides:

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

Recommended protection:

- require protected branches for deployments
- require reviewer approval on `production`
