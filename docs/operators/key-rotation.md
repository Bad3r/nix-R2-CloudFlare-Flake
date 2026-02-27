# OAuth Client Credential Rotation Runbook

## Purpose

Rotate OAuth2 client credentials used by `r2 share worker ...` automation
without interrupting share management operations.

## When to Use

- Scheduled credential rotation.
- Suspected client secret exposure.
- Operator handoff or boundary changes.

## Prerequisites

- Access to Better Auth IdP client management.
- Ability to update secrets/env used by CLI automation.
- Ability to run worker smoke checks.

## Inputs / Environment Variables

- `R2_EXPLORER_BASE_URL`
- `R2_EXPLORER_OAUTH_CLIENT_ID`
- `R2_EXPLORER_OAUTH_CLIENT_SECRET`
- `R2_EXPLORER_OAUTH_TOKEN_URL`

## Procedure (CLI-first)

1. Export existing values for rollback reference:

```bash
export OLD_CLIENT_ID="${R2_EXPLORER_OAUTH_CLIENT_ID}"
export OLD_CLIENT_SECRET="${R2_EXPLORER_OAUTH_CLIENT_SECRET}"
```

2. Create a new OAuth client in Better Auth IdP with required scopes for worker
   operations (`r2.read`, `r2.write`, `r2.share.manage`).

3. Update automation environment/secrets with the new credentials.

4. Validate token exchange and API probe:

```bash
token="$(
  curl -sS -X POST \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode 'grant_type=client_credentials' \
    --data-urlencode "client_id=${R2_EXPLORER_OAUTH_CLIENT_ID}" \
    --data-urlencode "client_secret=${R2_EXPLORER_OAUTH_CLIENT_SECRET}" \
    --data-urlencode 'scope=r2.read r2.write r2.share.manage' \
    "${R2_EXPLORER_OAUTH_TOKEN_URL}" | jq -r '.access_token // empty'
)"

curl -i -H "authorization: Bearer ${token}" "${R2_EXPLORER_BASE_URL%/}/api/v2/session/info"
```

5. Validate share lifecycle commands:

```bash
r2 share worker create files documents/test.txt 1h --max-downloads 1
r2 share worker list files documents/test.txt
```

6. Revoke/disable the old OAuth client after validation.

## Verification

- `r2 share worker create` succeeds with new credentials.
- `r2 share worker list` returns expected records.
- Old OAuth client no longer works after revocation.

## Failure Signatures and Triage

- `401 token_invalid_signature`:
  - IdP JWKS/signing issue or stale token.
- `401 token_claim_mismatch`:
  - audience/issuer mismatch.
- `403 insufficient_scope`:
  - client token missing required scope.

## Rollback / Recovery

1. Restore previous client credentials in automation env.
2. Re-run token exchange and share lifecycle checks.
3. Keep old client active until new credentials are confirmed healthy.

## Post-incident Notes

- Record rotation timestamp and actor.
- Record old/new client IDs and revocation time.
- Capture verification command outputs.
