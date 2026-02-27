# Access Policy Split Runbook

## Purpose

Use Cloudflare Access as an edge gate for interactive routes while preserving
public token download links and OAuth-based API authorization.

## When to Use

- Initial setup of R2-Explorer custom domain.
- Access policy drift correction.
- Recovery from unexpected public/private route exposure.

## Prerequisites

- Access to Cloudflare Access policy management for target domain.
- Worker deployed on `files.unsigned.sh` and (if enabled) `preview.files.unsigned.sh`.
- At least one valid share token for validation.
- OAuth issuer/client setup already active for API calls.

## Inputs / Environment Variables

- Target domains:
  - `files.unsigned.sh`
  - `preview.files.unsigned.sh` (if preview route split is enabled)
- Access policy include rules for org users/groups.
- Existing share token ID for public path verification.

## Procedure (CLI-first)

1. Ensure Access app coverage is split by path for each host:
   - Protected API: `<host>/api/v2/*` with policy action `Allow` for trusted identities.
   - Public download bypass: `<host>/share/*` with policy action `Bypass`.
   - Machine share-management bypass: `<host>/api/v2/share/*` with policy action `Bypass`.
2. Confirm the more-specific bypass apps (`/share/*` and `/api/v2/share/*`) take
   precedence over broad protected routes.
3. Validate protected API routes (should redirect to Access login when
   unauthenticated):

```bash
curl -I https://files.unsigned.sh/api/v2/list
curl -I https://preview.files.unsigned.sh/api/v2/list
```

4. Validate public token route (no Access redirect):

```bash
curl -I https://files.unsigned.sh/share/<token-id>
curl -I https://preview.files.unsigned.sh/share/<token-id>
```

5. Validate machine API bypass behavior (no Access redirect, but OAuth still
   required):

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://files.unsigned.sh/api/v2/share/list
```

Expected status without token is `401` (`oauth_required`), not `302`.

6. Validate worker-share lifecycle with OAuth credentials:

```bash
r2 share worker create files workspace/demo.txt 10m --max-downloads 1
```

## Verification

- `/api/v2/*` remains Access-protected for browser/interactive traffic.
- `/share/<token-id>` is reachable without Access membership and still enforces
  token validity.
- `/api/v2/share/*` bypasses Access but still requires OAuth bearer tokens with
  `R2E_AUTH_SCOPE_SHARE_MANAGE`.
- Worker is configured with `R2E_AUTH_ISSUER`, `R2E_AUTH_AUDIENCE`, and
  `R2E_AUTH_JWKS_URL`, and `/api/v2/*` rejects missing or invalid bearer tokens.

## Failure Signatures and Triage

- `/share/*` redirects to Access login:
  - bypass policy missing, disabled, or lower precedence than broad rule.
- `r2 share worker create` fails with `HTTP 302`:
  - `/api/v2/share/*` bypass is missing, so Access is intercepting machine calls.
- `/api/v2/share/*` returns `200` without bearer token:
  - Worker middleware regression; OAuth auth/scope enforcement is not active.
- `/api/v2/*` is publicly reachable:
  - broad Access policy too permissive or bypass too broad.

## Rollback / Recovery

1. Reapply last known-good policy pair:
   - `/*` allow for org identities.
   - `/share/*` bypass only.
2. Re-run curl checks for protected and public path behavior.
3. Audit policy edits and actor history in Cloudflare account logs.

## Post-incident Notes

- Record policy IDs, order, and change timestamp.
- Document blast radius and any temporarily exposed paths.
