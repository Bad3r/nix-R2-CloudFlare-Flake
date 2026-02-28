# Sharing

This repository supports two sharing modes.

Option reference for CLI and credentials behavior: `docs/reference/index.md`.

Quickstart entrypoint: run the sharing checkpoint in `docs/quickstart.md` first, then use this page for detailed mode-specific behavior and policy setup.
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
- `R2_EXPLORER_ACCESS_CLIENT_ID`
- `R2_EXPLORER_ACCESS_CLIENT_SECRET`

Multi-bucket aliases:

- Optional `R2E_BUCKET_MAP` defines bucket aliases to Worker bindings.
- The map must include `{"files":"FILES_BUCKET"}` to keep default behavior.
- Each additional alias requires a matching `[[r2_buckets]]` binding in `wrangler.toml`.

Example:

```bash
export R2E_BUCKET_MAP='{"files":"FILES_BUCKET","photos":"PHOTOS_BUCKET"}'
```

Behavior and constraints:

- Share URL format: `https://files.unsigned.sh/share/<token-id>`
- Token IDs are random and backed by KV record state (`R2E_SHARES_KV`).
- `/share/<token-id>` validates expiry/revocation/download limits.
- `/api/v2/*` is gated by Cloudflare Access and validated in-worker from:
  - `Cf-Access-Jwt-Assertion` request header.
  - `CF_Authorization` (or `CF_Authorization_*`) cookie.
- CLI/machine callers authenticate with Access service-token headers:
  - `CF-Access-Client-Id`
  - `CF-Access-Client-Secret`

Failure semantics:

- Missing Access identity for `/api/v2/*`: `401 access_required` (or Access login redirect at edge)
- Invalid signature/JWKS/key selection: `401 token_invalid_signature`
- Issuer/audience mismatch: `401 token_claim_mismatch`
- Missing required scope: `403 insufficient_scope`
- Missing verifier config (`R2E_ACCESS_TEAM_DOMAIN` / `R2E_ACCESS_AUD`): `500 access_config_invalid`

## Edge routing model

Cloudflare edge config should route paths and keep Access policy split aligned:

1. API routes:

- Domain/path: `files.unsigned.sh/api/v2/*`
- Cloudflare Access app required (`allow` + `Service Auth`, no `bypass`)
- Worker enforces Access JWT verification (`Cf-Access-Jwt-Assertion`/`CF_Authorization`)

2. Public share routes:

- Domain/path: `files.unsigned.sh/share/*`
- Public by token design (Access app should use `bypass` policy only)

3. Preview should mirror production semantics:

- `preview.files.unsigned.sh/api/v2/*` Access protected and validated in-worker
- `preview.files.unsigned.sh/share/*` public by token

Important: `/api/v2/share/*` is protected API surface and requires bearer scope.

## Operator runbooks

Use dedicated runbooks for operations and incident handling:

- `docs/operators/index.md`
- `docs/operators/readonly-maintenance.md`
- `docs/operators/access-policy-split.md`
- `docs/operators/incident-response.md`
- `docs/operators/rollback-worker-share.md`
