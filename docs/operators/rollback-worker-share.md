# Worker/Share Rollback Runbook

## Purpose

Restore last known-good Worker/share behavior after failed deployment or config
regression.

## When to Use

- Post-deploy smoke check failure.
- Deploy workflow smoke jobs fail (`smoke-preview` or `smoke-production`).
- Auth or share lifecycle regressions introduced by config/code changes.
- Route/auth configuration drift causing incorrect exposure or auth failures.

## Prerequisites

- Access to prior deployment revision or release artifact.
- Access to prior environment variable snapshot.
- Ability to redeploy Worker.

## Inputs / Environment Variables

- Last known-good Worker revision identifier.
- Last known-good values for:
  - `R2E_READONLY`
  - IdP verification variables (`R2E_IDP_ISSUER`, `R2E_IDP_AUDIENCE`,
    optional JWKS/scope overrides)
  - bound KV namespace and bucket configuration (`R2E_FILES_BUCKET`,
    `R2E_FILES_BUCKET_PREVIEW`, `R2E_SHARES_KV_ID`,
    `R2E_SHARES_KV_ID_PREVIEW`)
- Target domain for verification (`https://files.unsigned.sh`)

## Procedure (CLI-first)

1. Identify rollback target:
   - Most recent known-good deployment passing share/API smoke tests.
2. Reapply previous Worker code/config revision.
3. Reapply previous environment snapshot.
4. Deploy rollback revision:

```bash
./scripts/ci/render-r2-explorer-wrangler-config.sh r2-explorer/wrangler.ci.toml
cd r2-explorer
wrangler deploy --config wrangler.ci.toml
```

5. Validate lifecycle and route behavior:

```bash
r2 share worker create files documents/test.txt 1h --max-downloads 1
r2 share worker list files documents/test.txt
curl -I https://files.unsigned.sh/api/v2/list
curl -I https://files.unsigned.sh/share/<token-id>
```

## Verification

- Share lifecycle endpoints return expected status.
- `/api/v2/*` remains bearer-protected in-worker.
- `/share/*` remains public-token accessible and token-constrained.

## Failure Signatures and Triage

- Code rollback succeeded but auth still fails:
  - stale OAuth client credentials or stale IdP env values.
- Public links fail while API works:
  - share token state or route mapping regression.
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
