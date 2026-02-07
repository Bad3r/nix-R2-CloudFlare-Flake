# Sharing

This repository supports two sharing modes.

Option reference for CLI and credentials behavior: `docs/reference/index.md`.

## 1) Presigned URLs (R2 S3 endpoint)

Use the primary command:

```bash
r2 share <bucket> <key> [expiry]
```

Examples:

```bash
r2 share documents report.pdf
r2 share documents report.pdf 168h
```

Notes:

- URLs are generated against the R2 S3 endpoint.
- Credentials are loaded from `R2_CREDENTIALS_FILE` (default:
  `~/.config/cloudflare/r2/env`).
- Required variables in the sourced credentials file:
  - `R2_ACCOUNT_ID` (or HM-injected `R2_DEFAULT_ACCOUNT_ID`)
  - `AWS_ACCESS_KEY_ID`
  - `AWS_SECRET_ACCESS_KEY`

## 2) Worker token links (custom domain)

Worker-mode share operations use the R2-Explorer API:

```bash
r2 share worker create <bucket> <key> [ttl] [--max-downloads N]
r2 share worker list <bucket> <key>
r2 share worker revoke <token-id>
```

Required environment variables for Worker-mode CLI calls:

- `R2_EXPLORER_BASE_URL` (for example `https://files.example.com`)
- `R2_EXPLORER_ADMIN_KID` (active or previous key id from `R2E_KEYS_KV`)
- `R2_EXPLORER_ADMIN_SECRET` (matching key material)

Behavior and constraints:

- Share URL format: `https://files.example.com/share/<token-id>`
- Token IDs are random and backed by KV record state (`R2E_SHARES_KV`).
- `/share/<token-id>` validates expiry/revocation/download limits.
- Worker admin HMAC keyset and replay-nonce state are stored in `R2E_KEYS_KV`.
- `/api/*` routes require Cloudflare Access identity.
- `r2 share worker ...` can authenticate with HMAC headers (no browser Access
  session required).

## Cloudflare Access policy model

Use path-based policy split so interactive/admin APIs stay authenticated while
public token links work as intended:

1. Access-protected app policy:

- Domain: `files.example.com`
- Path: `/*`
- Action: `Allow`
- Include: your org users/groups

2. Share-link bypass policy:

- Domain: `files.example.com`
- Path: `/share/*`
- Action: `Bypass`

This keeps `/api/*` and `/` behind Access while allowing `GET /share/<token>`
to work for recipients without Access membership.

## Operator runbooks

Use dedicated runbooks for operations and incident handling:

- `docs/operators/index.md`
- `docs/operators/key-rotation.md`
- `docs/operators/readonly-maintenance.md`
- `docs/operators/access-policy-split.md`
- `docs/operators/incident-response.md`
- `docs/operators/rollback-worker-share.md`
