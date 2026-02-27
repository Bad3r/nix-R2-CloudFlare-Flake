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
- `R2_EXPLORER_ADMIN_KID` (active or previous key id from `R2E_KEYS_KV`)
- `R2_EXPLORER_ADMIN_SECRET` (matching key material; plain text or `base64:<value>`)

Optional (only when `/api/v2/share/*` is behind Access instead of bypass):

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
- Worker admin HMAC keyset and replay-nonce state are stored in `R2E_KEYS_KV`.
- `/api/v2/*` routes require Cloudflare Access JWT verification (`Cf-Access-Jwt-Assertion`) plus expected issuer/audience.
- `r2 share worker ...` authenticates request integrity with admin HMAC headers.
- When `/api/v2/share/*` is Access-protected, CLI calls can additionally present
  Access service-token headers via `R2_EXPLORER_ACCESS_CLIENT_ID` and
  `R2_EXPLORER_ACCESS_CLIENT_SECRET`.

Required Worker vars for `/api/v2/*` JWT verification:

- `R2E_ACCESS_TEAM_DOMAIN` (for example `team.cloudflareaccess.com`)
- `R2E_ACCESS_AUD` (Access application audience value)

Failure semantics:

- Missing `Cf-Access-Jwt-Assertion` for `/api/v2/*`: `401 access_required`
- Invalid JWT signature/claims: `401 access_jwt_invalid`
- Missing verifier config (`R2E_ACCESS_TEAM_DOMAIN` or `R2E_ACCESS_AUD`): `500 access_config_invalid`

## Cloudflare Access policy model

Use path-based policy split so interactive/admin APIs stay authenticated while
public token links work as intended:

1. Access-protected app policy:

- Domain: `files.unsigned.sh`
- Path: `/*`
- Action: `Allow`
- Include: your org users/groups

2. Share-link bypass policy (public download):

- Domain: `files.unsigned.sh`
- Path: `/share/*`
- Action: `Bypass`

3. Share-management API bypass policy (HMAC admin):

- Domain: `files.unsigned.sh`
- Path: `/api/v2/share/*`
- Action: `Bypass`

This keeps `/` and `/api/v2/*` behind Access while allowing:

- `GET /share/<token>` to work for recipients without Access membership
- `r2 share worker create|list|revoke ...` to work via HMAC without a browser
  Access session

Note: `/api/v2/share/*` is still protected by Worker auth. The Worker requires
either a valid Cloudflare Access JWT or valid HMAC admin headers for these
endpoints.

Important: when `/api/v2/share/*` is configured as an Access `Bypass`, Access will
not inject `Cf-Access-Jwt-Assertion` headers on those requests. Browser sessions
can still be authenticated by the Worker via the `CF_Authorization` cookie
(validated against `R2E_ACCESS_TEAM_DOMAIN` + `R2E_ACCESS_AUD`). CLI-driven
requests use HMAC admin headers.

Important: Access policy split alone is not sufficient. The Worker must also
verify Access JWT signature and claims on `/api/v2/*`.

## Operator runbooks

Use dedicated runbooks for operations and incident handling:

- `docs/operators/index.md`
- `docs/operators/key-rotation.md`
- `docs/operators/readonly-maintenance.md`
- `docs/operators/access-policy-split.md`
- `docs/operators/incident-response.md`
- `docs/operators/rollback-worker-share.md`
