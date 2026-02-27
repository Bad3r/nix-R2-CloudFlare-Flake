# Readonly Maintenance Runbook

## Purpose

Place R2-Explorer into readonly mode for planned maintenance while preserving
read/list behavior.

## When to Use

- Planned maintenance windows.
- Temporary freeze during investigation.
- Controlled deployments where writes must be blocked.

## Prerequisites

- Ability to deploy `r2-explorer` with env changes.
- Access to production `wrangler` environment.
- Existing smoke-test object available for validation.

## Inputs / Environment Variables

- `R2E_READONLY`
- `R2_EXPLORER_BASE_URL`
- OAuth env for CLI calls:
  - `R2_EXPLORER_OAUTH_CLIENT_ID`
  - `R2_EXPLORER_OAUTH_CLIENT_SECRET`
  - `R2_EXPLORER_OAUTH_TOKEN_URL`
  - `R2_EXPLORER_OAUTH_RESOURCE`

## Procedure (CLI-first)

1. Announce maintenance window and freeze write operations.
2. Enable readonly mode in Worker environment (`R2E_READONLY=true`).
3. Deploy Worker:

```bash
cd r2-explorer
wrangler deploy
```

4. Validate mutating admin paths are blocked:

```bash
r2 share worker create files documents/test.txt 1h --max-downloads 1
```

5. Validate non-mutating operations still work:

```bash
r2 share worker list files documents/test.txt
curl -I "https://files.unsigned.sh/share/<token-id>"
```

6. After maintenance, set `R2E_READONLY=false` and redeploy.

## Verification

- Create/revoke actions return readonly failure.
- List operations continue to function.
- Public token download path responds as expected for valid token.

## Failure Signatures and Triage

- Create/revoke still succeeds in readonly mode:
  - env var not applied to active deployment.
- All routes fail after readonly deploy:
  - broader deploy/config regression, not readonly-only behavior.
- Inconsistent behavior across requests:
  - rollout propagation delay; retest after short interval.

## Rollback / Recovery

1. Reapply last known-good environment snapshot.
2. Redeploy Worker.
3. Verify create/list/revoke and public share behavior.

## Post-incident Notes

- Capture window start/end times.
- Record any operations blocked/unblocked unexpectedly.
