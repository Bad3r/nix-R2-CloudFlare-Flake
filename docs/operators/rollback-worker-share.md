# Worker/Share Rollback Runbook

## Purpose

Restore last known-good Worker/share behavior after failed deployment or config
regression.

## When to Use

- Post-deploy smoke check failure.
- Deploy workflow smoke jobs fail (`smoke-preview` or `smoke-production`).
- Auth or share lifecycle regressions introduced by config/code changes.
- Access policy changes causing incorrect route exposure.

## Prerequisites

- Access to prior deployment revision or release artifact.
- Access to prior environment variable snapshot.
- Ability to redeploy Worker and modify Access policies.

## Inputs / Environment Variables

- Last known-good Worker revision identifier.
- Last known-good values for:
  - `R2E_READONLY`
  - keyset/secret references for admin auth
  - bound KV namespace configuration
- Target domain for verification (`https://files.example.com`)

## Procedure (CLI-first)

1. Identify rollback target:
   - Most recent known-good deployment passing share/API smoke tests.
2. Reapply previous Worker code/config revision.
3. Reapply previous environment snapshot.
4. Reconfirm Access policy split:
   - `/*` allow for org identities.
   - `/share/*` bypass.
5. Deploy rollback revision:

```bash
cd r2-explorer
wrangler deploy
```

6. Validate lifecycle and route behavior:

```bash
r2 share worker create files documents/test.txt 1h --max-downloads 1
r2 share worker list files documents/test.txt
curl -I https://files.example.com/api/list
curl -I https://files.example.com/share/<token-id>
```

## Verification

- Admin share lifecycle endpoints return expected status.
- `/api/*` remains Access-protected.
- `/share/*` remains public-token accessible and token-constrained.

## Failure Signatures and Triage

- Code rollback succeeded but auth still fails:
  - stale env secrets or keyset mismatch.
- Public links fail while API works:
  - Access bypass path missing/regressed.
- KV-driven behavior inconsistent:
  - wrong namespace binding for active environment.

## Rollback / Recovery

1. If first rollback target fails, move one revision further back.
2. Reapply matching env snapshot for that revision.
3. Re-verify with lifecycle + curl checks.
4. Escalate and keep readonly mode enabled if stable operation is not restored.

## Post-incident Notes

- Record rollback target revision and restored config version.
- Capture failing and restored smoke-test outputs.
