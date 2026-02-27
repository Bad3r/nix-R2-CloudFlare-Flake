# Incident Response Runbook

## Purpose

Provide a repeatable response workflow for R2-Explorer auth/share incidents.

## When to Use

- Suspected OAuth client credential leak.
- Suspected OAuth signing key/JWKS compromise.
- Unexpected public/private route exposure.
- Worker share API outage or elevated auth failures.

## Prerequisites

- On-call operator access to Worker deploy/config controls.
- Ability to toggle readonly mode.
- Ability to rotate OAuth credentials and adjust Access policies.
- Access to runtime logs and deployment history.

## Inputs / Environment Variables

- `R2_EXPLORER_BASE_URL`
- `R2E_READONLY`
- `R2E_AUTH_ISSUER`
- `R2E_AUTH_AUDIENCE`
- `R2E_AUTH_JWKS_URL`
- `R2E_SHARES_KV`
- Active machine credentials (`R2_EXPLORER_OAUTH_CLIENT_ID`)

## Procedure (CLI-first)

1. Classify severity:
   - SEV-1: active data exposure or unauthorized write access.
   - SEV-2: degraded share lifecycle/auth without confirmed exposure.
2. Immediate containment (choose minimum required controls):
   - Enable readonly mode (`R2E_READONLY=true`) and redeploy.
   - Revoke affected share tokens.
   - Rotate compromised OAuth client credentials.
   - If signing-key compromise is suspected, rotate issuer signing keys and keep
     short overlap.
   - Tighten Access policy split if exposure is route-based.
3. Validate containment:

```bash
curl -I https://files.unsigned.sh/api/v2/list
curl -I https://files.unsigned.sh/share/<token-id>
r2 share worker list files documents/test.txt
```

4. Investigate:
   - Check recent deploy/config changes.
   - Review issuer/JWKS state and key set history at auth provider.
   - Review share token state in `R2E_SHARES_KV`.
5. Recover:
   - Restore expected policy/config state.
   - Disable readonly if no longer required.
   - Confirm lifecycle commands succeed.

## Verification

- Containment controls produce expected route and mutation behavior.
- No unauthorized path remains exposed after mitigation.
- Normal share lifecycle works after credential/key recovery.

## Failure Signatures and Triage

- Persistent `401 oauth_token_invalid` after credential rotation:
  - issuer/audience/jwks mismatch between Worker and auth provider.
- `r2 share worker ...` fails with `oauth_required`:
  - CLI env not exporting `R2_EXPLORER_OAUTH_*` values.
- Share tokens remain valid after revoke:
  - KV write failure or stale deployment binding.
- API routes intermittently public:
  - Access policy conflict or propagation lag.

## Rollback / Recovery

1. Revert to last known-good Worker deployment + env snapshot.
2. Restore known-good Access policy split.
3. Recheck protected/public route behavior.
4. Re-run share create/list/revoke smoke tests.

## Post-incident Notes

- Record timeline (detection, containment, recovery).
- Record root cause and preventive action items.
- Attach exact commands and response samples used for validation.
