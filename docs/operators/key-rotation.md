# Access Service Token Rotation Runbook

## Purpose

Rotate Cloudflare Access service-token credentials used by `r2 share worker ...`
automation without interrupting share-management operations.

## When to Use

- Scheduled credential rotation.
- Suspected service-token secret exposure.
- Operator handoff or boundary changes.

## Prerequisites

- Access to Cloudflare Zero Trust service-token management.
- Ability to update secrets/env used by CLI automation.
- Ability to run worker smoke checks.

## Inputs / Environment Variables

- `R2_EXPLORER_BASE_URL`
- `R2_EXPLORER_ACCESS_CLIENT_ID`
- `R2_EXPLORER_ACCESS_CLIENT_SECRET`

## Procedure (CLI-first)

1. Export existing values for rollback reference:

```bash
export OLD_CLIENT_ID="${R2_EXPLORER_ACCESS_CLIENT_ID}"
export OLD_CLIENT_SECRET="${R2_EXPLORER_ACCESS_CLIENT_SECRET}"
```

2. Create a new Access service token in Cloudflare Zero Trust.

3. Update automation environment/secrets with the new values.

4. Validate API probe with service-token headers:

```bash
curl -i \
  -H "CF-Access-Client-Id: ${R2_EXPLORER_ACCESS_CLIENT_ID}" \
  -H "CF-Access-Client-Secret: ${R2_EXPLORER_ACCESS_CLIENT_SECRET}" \
  "${R2_EXPLORER_BASE_URL%/}/api/v2/session/info"
```

5. Validate share lifecycle commands:

```bash
r2 share worker create files documents/test.txt 1h --max-downloads 1
r2 share worker list files documents/test.txt
```

6. Revoke/disable the old service token after validation.

## Verification

- `r2 share worker create` succeeds with new credentials.
- `r2 share worker list` returns expected records.
- Old service token no longer works after revocation.

## Failure Signatures and Triage

- `401 access_required`:
  - wrong client ID/secret pair or missing Service Auth policy.
- `401 token_invalid_signature`:
  - Access JWKS/signing issue.
- `401 token_claim_mismatch`:
  - Access AUD mismatch.
- `403 insufficient_scope`:
  - Worker scope requirements are stricter than token claims.

## Rollback / Recovery

1. Restore previous service-token credentials in automation env.
2. Re-run API probe and share lifecycle checks.
3. Keep old token active until new credentials are confirmed healthy.

## Post-incident Notes

- Record rotation timestamp and operator.
- Record old/new client IDs and revocation time.
- Capture verification command outputs.
