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
- A bucket literally named `worker` cannot be used with `r2 share`, because
  `worker` is the `r2 share worker` subcommand keyword. There is no escape
  hatch; rename the bucket or use `r2 share worker` instead.
- Required variables in the sourced credentials file:
  - `R2_ACCOUNT_ID` (falls back to the HM-injected `R2_DEFAULT_ACCOUNT_ID` when
    unset; if both are set and differ, `R2_ACCOUNT_ID` wins and the CLI prints
    a warning to stderr)
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
- A share record stores the bucket alias, not a resolved binding; `/share/<token-id>` resolves it
  against the current `R2E_BUCKET_MAP` at download time. Removing an alias breaks every outstanding
  share that used it (`bucket_unknown`); repointing an alias to a different binding silently
  redirects those shares to the new bucket. List and revoke outstanding shares for an alias with
  `/api/v2/share/list` before removing or repointing it.

Example:

```bash
export R2E_BUCKET_MAP='{"files":"FILES_BUCKET","photos":"PHOTOS_BUCKET"}'
```

Behavior and constraints:

- Share URL format: `https://files.unsigned.sh/share/<token-id>`
- Token IDs are random and backed by KV record state (`R2E_SHARES_KV`).
- `/share/<token-id>` enforces expiry, revocation, and `maxDownloads` through a per-token
  `ShareCounterDurableObject`, which stays authoritative even when a KV read at some edge is still
  showing a stale pre-revocation or pre-exhaustion record, in both normal and readonly mode:
  readonly mode still calls the counter's read-only status check and refuses a revoked or exhausted
  share, it only skips writing the count, so `maxDownloads` decrementing, not enforcement, is what
  is skipped while `R2E_READONLY` is enabled.
- Download accounting: a request that serves a body starting at byte 0 (no `Range` header, or a
  `Range` whose first byte is 0, including `bytes=0-`) is a download start and consumes one slot
  before any byte is served. A request with a satisfiable `Range` starting past byte 0 is a
  continuation: it consumes no slot when the token already has a counted download start within the
  last 15 minutes, even if that start already reached `maxDownloads`; outside that window, or with
  no prior counted start, it is treated as a new download start instead.
- `HEAD`, and any request that ends in `304`/`412`/`416`, never consume a slot. Their status is
  decided from the rule "would a GET carrying these same headers be refused": a `Range` header on
  the request describing an offset past 0 grants the same resume-window exemption a real
  continuation would get, even on a `HEAD`, which never honors `Range` in what it serves; a request
  with no such `Range` header gets no exemption and is refused exactly like a fresh download start
  would be. Revocation and expiry are never exempted by this rule.
- `/share/<token-id>` always sends `Accept-Ranges: bytes` and supports the same `Range` and
  `If-Match`/`If-None-Match`/`If-Modified-Since`/`If-Unmodified-Since` conditional requests as
  `/api/v2/download`.
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
