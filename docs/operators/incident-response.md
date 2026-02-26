# Incident Response Runbook

## Purpose

Provide a repeatable response workflow for R2-Explorer sharing incidents.

## When to Use

- Suspected token abuse or leak.
- Suspected admin key compromise.
- Unexpected public/private route exposure.
- Worker share API outage or elevated auth failures.

## Prerequisites

- On-call operator access to Worker deploy/config controls.
- Ability to toggle readonly mode.
- Ability to rotate keys and adjust Access policies.
- Access to runtime logs and deployment history.

## Inputs / Environment Variables

- `R2_EXPLORER_BASE_URL`
- `R2E_READONLY`
- `R2E_KEYS_KV`
- `R2E_SHARES_KV`
- Active admin key identifiers (`R2_EXPLORER_ADMIN_KID`)

## Procedure (CLI-first)

1. Classify severity:
   - SEV-1: active data exposure or unauthorized write access.
   - SEV-2: degraded admin/share lifecycle without confirmed exposure.
2. Immediate containment (choose minimum required controls):
   - Enable readonly mode (`R2E_READONLY=true`) and redeploy.
   - Revoke affected share tokens.
   - Apply emergency key rotation.
   - Tighten Access policy split if exposure is route-based.
3. Validate containment:

```bash
curl -I https://files.unsigned.sh/api/v2/list
curl -I https://files.unsigned.sh/share/<token-id>
r2 share worker list files documents/test.txt
```

4. Investigate:
   - Check recent deploy/config changes.
   - Review keyset state in `R2E_KEYS_KV`.
   - Review share token state in `R2E_SHARES_KV`.
5. Recover:
   - Restore expected policy/config state.
   - Disable readonly if no longer required.
   - Confirm lifecycle commands succeed.

## Verification

- Containment controls produce expected route and mutation behavior.
- No unauthorized path remains exposed after mitigation.
- Normal share lifecycle works after recovery.

## Failure Signatures and Triage

- Persistent `401/403` after key rotation:
  - inconsistent automation secret rollout.
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
