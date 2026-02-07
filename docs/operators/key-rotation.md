# Key Rotation Runbook

## Purpose

Rotate Worker admin HMAC credentials used by `r2 share worker ...` automation
without interrupting share management operations.

## When to Use

- Scheduled key rotation.
- Suspected admin secret exposure.
- Operator handoff or boundary changes.

## Prerequisites

- `wrangler` and `r2` are installed.
- You can deploy `r2-explorer`.
- You can update secrets/env used by CLI automation.
- `R2E_KEYS_KV` is bound in `wrangler.toml`.

## Inputs / Environment Variables

- `R2_EXPLORER_BASE_URL`
- `R2_EXPLORER_ADMIN_KID`
- `R2_EXPLORER_ADMIN_SECRET`
- Active Worker KV namespace binding for `R2E_KEYS_KV`

## Procedure (CLI-first)

1. Export existing values for rollback reference:

```bash
export OLD_KID="${R2_EXPLORER_ADMIN_KID}"
export OLD_SECRET="${R2_EXPLORER_ADMIN_SECRET}"
```

2. Generate new key material:

```bash
export NEW_KID="ops-$(date -u +%Y%m%d%H%M%S)"
export NEW_SECRET="$(openssl rand -hex 32)"
```

3. Add the new key to the Worker keyset while keeping the old key valid during
   overlap. Update KV state so `active` is `NEW_KID` and old key is retained as
   previous.

4. Deploy Worker config update:

```bash
cd r2-explorer
wrangler deploy
```

5. Update automation environment to the new active key:

```bash
export R2_EXPLORER_ADMIN_KID="${NEW_KID}"
export R2_EXPLORER_ADMIN_SECRET="${NEW_SECRET}"
```

6. Validate worker-admin share lifecycle calls:

```bash
r2 share worker create files documents/test.txt 1h --max-downloads 1
r2 share worker list files documents/test.txt
```

7. End overlap window and remove old key from keyset after successful validation.

## Verification

- `r2 share worker create` succeeds with the new key.
- `r2 share worker list` returns expected records.
- Worker responses no longer accept the old key after overlap removal.

## Failure Signatures and Triage

- `401 Unauthorized` with valid timestamp:
  - `R2_EXPLORER_ADMIN_KID` does not match keyset.
- `403 Forbidden` on admin routes:
  - secret mismatch or stale secret in automation.
- Intermittent signature failures:
  - clock skew between caller and Worker verifier.

## Rollback / Recovery

1. Restore previous key as `active` in `R2E_KEYS_KV`.
2. Re-export previous automation credentials:

```bash
export R2_EXPLORER_ADMIN_KID="${OLD_KID}"
export R2_EXPLORER_ADMIN_SECRET="${OLD_SECRET}"
```

3. Redeploy Worker and rerun lifecycle verification commands.

## Post-incident Notes

- Record rotation timestamp, operator, and retired key ID.
- Document overlap duration and reason for emergency vs scheduled rotation.
