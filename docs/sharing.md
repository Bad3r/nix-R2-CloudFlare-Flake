# Sharing

This repository supports two sharing modes.

Option reference for CLI and credentials behavior: `docs/reference/index.md`.

Quickstart entrypoint: run the sharing checkpoint in `docs/quickstart.md`
first, then use this page for detailed mode-specific behavior and policy setup.
For auth/token/multipart failures, use `docs/troubleshooting.md` first, then
escalate to operator runbooks as needed.

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
- System-wide deployments typically point `R2_CREDENTIALS_FILE` at
  `/run/secrets/r2/credentials.env` rendered from `secrets/r2.yaml`.
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

- `R2_EXPLORER_BASE_URL` (for example `https://files.unsigned.sh`)
- `R2_EXPLORER_OAUTH_TOKEN_URL` (for example `https://auth.example.com/oauth2/token`)
- `R2_EXPLORER_OAUTH_CLIENT_ID`
- `R2_EXPLORER_OAUTH_CLIENT_SECRET`

Multi-bucket aliases:

- Optional `R2E_BUCKET_MAP` defines bucket aliases to Worker bindings.
- The map must include `{"files":"FILES_BUCKET"}` to keep default behavior.
- Each additional alias requires a matching `[[r2_buckets]]` binding in
  `wrangler.toml`.

Example:

```bash
export R2E_BUCKET_MAP='{"files":"FILES_BUCKET","photos":"PHOTOS_BUCKET"}'
```

Behavior and constraints:

- Share URL format: `https://files.unsigned.sh/share/<token-id>`
- Token IDs are random and backed by KV record state (`R2E_SHARES_KV`).
- `/share/<token-id>` validates expiry/revocation/download limits.
- `/api/v2/*` routes require OAuth Bearer JWT validation
  (`Authorization: Bearer ...`).
- Share management APIs require `r2.share.manage`.
- Read routes require `r2.read`; upload/object mutations require `r2.write`.

Required Worker vars for `/api/v2/*` OAuth verification:

- `R2E_AUTH_ISSUER`
- `R2E_AUTH_AUDIENCE`
- Optional `R2E_AUTH_JWKS_URL` (defaults to `${R2E_AUTH_ISSUER}/jwks`)

Failure semantics:

- Missing bearer token for `/api/v2/*`: `401 oauth_required`
- Invalid JWT signature/claims: `401 oauth_token_invalid`
- Missing verifier config (`R2E_AUTH_ISSUER` or `R2E_AUTH_AUDIENCE`):
  `500 oauth_config_invalid`
- Missing route scope: `403 insufficient_scope`

## Access policy model

Recommended path split for `files.unsigned.sh`:

1. Protected API policy:

- Domain: `files.unsigned.sh`
- Path: `/api/v2/*`
- Action: `Allow`

2. Share-link bypass policy (public download):

- Domain: `files.unsigned.sh`
- Path: `/share/*`
- Action: `Bypass`

3. Machine share-management bypass policy:

- Domain: `files.unsigned.sh`
- Path: `/api/v2/share/*`
- Action: `Bypass`

Preview environment should mirror this split with independent Access apps:

- API protected app: `preview.files.unsigned.sh/api/v2/*`
- Public share bypass app: `preview.files.unsigned.sh/share/*`
- Machine share-management bypass app: `preview.files.unsigned.sh/api/v2/share/*`

This keeps `/api/v2/*` behind Access while allowing:

- `GET /share/<token>` for recipients without Access membership
- `r2 share worker create|list|revoke ...` via OAuth client credentials without
  Access browser/session requirements

Important: Access policy split alone is not sufficient. The Worker must also
verify OAuth JWT signature/claims and route scopes on `/api/v2/*`.

## Operator runbooks

Use dedicated runbooks for operations and incident handling:

- `docs/operators/index.md`
- `docs/operators/readonly-maintenance.md`
- `docs/operators/access-policy-split.md`
- `docs/operators/incident-response.md`
- `docs/operators/rollback-worker-share.md`
