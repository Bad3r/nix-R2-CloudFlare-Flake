# Direct IdP Auth Routing Runbook

## Purpose

Ensure the edge routing model matches the direct IdP design:

- `/api/v2/*` is bearer-protected in-worker.
- `/share/*` is public token download.

## When to Use

- Initial setup of R2-Explorer custom domain.
- Route/auth drift correction.
- Recovery from unexpected public/private route exposure.

## Prerequisites

- Access to Cloudflare route configuration for target domain.
- Worker deployed on `files.unsigned.sh` (or equivalent domain).
- At least one valid share token for validation.
- Valid OAuth2 client credentials for API validation.

## Inputs / Environment Variables

- Target domain, example: `files.unsigned.sh`
- `R2E_IDP_ISSUER`
- `R2E_IDP_AUDIENCE`
- Existing share token ID for public path verification

## Procedure (CLI-first)

1. Confirm API and share routes are mapped to the API Worker:
   - `files.unsigned.sh/api/v2/*`
   - `files.unsigned.sh/share/*`
   - `preview.files.unsigned.sh/api/v2/*`
   - `preview.files.unsigned.sh/share/*`

2. Confirm no stale Access-only routing assumptions remain in deployment docs/config.

3. Validate protected API routes without bearer token:

```bash
curl -i https://files.unsigned.sh/api/v2/session/info
curl -i https://preview.files.unsigned.sh/api/v2/session/info
```

Expected: `401` and error code `token_missing`.

4. Validate public token route (no bearer token):

```bash
curl -I https://files.unsigned.sh/share/<token-id>
curl -I https://preview.files.unsigned.sh/share/<token-id>
```

5. Validate bearer token path with OAuth2 client credentials:

```bash
token="$(
  curl -sS -X POST \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode 'grant_type=client_credentials' \
    --data-urlencode 'client_id=<client-id>' \
    --data-urlencode 'client_secret=<client-secret>' \
    --data-urlencode 'scope=r2e.read r2e.write r2e.admin' \
    --data-urlencode 'resource=https://files.unsigned.sh' \
    https://auth.unsigned.sh/api/auth/oauth2/token | jq -r '.access_token // empty'
)"

curl -i \
  -H "authorization: Bearer ${token}" \
  https://files.unsigned.sh/api/v2/session/info
```

## Verification

- `/api/v2/*` denies unauthenticated requests with `token_missing`.
- `/api/v2/*` accepts valid bearer tokens with expected issuer/audience/scope.
- `/share/<token-id>` remains reachable without bearer token and enforces token validity.
- `/api/v2/share/*` remains protected by bearer scope.

## Failure Signatures and Triage

- `/share/*` unexpectedly requires auth:
  - route mapping or worker behavior regression.
- `/api/v2/*` returns `token_invalid_signature` globally:
  - JWKS endpoint/issuer config outage.
- `/api/v2/*` returns `token_claim_mismatch`:
  - audience/issuer mismatch between IdP and Worker env config.

## Rollback / Recovery

1. Restore previous known-good Worker deployment + env snapshot.
2. Restore previous known-good route map.
3. Re-run both protected/public path checks.
4. Audit recent route/env changes.

## Post-incident Notes

- Record changed routes and timestamps.
- Record IdP env values before/after (`issuer`, `audience`, `jwks`).
- Capture failing and restored request/response evidence.
