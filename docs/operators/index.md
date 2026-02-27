# Operator Runbooks

This section contains operator-facing procedures for R2-Explorer sharing
operations.

For share mode architecture and end-user behavior, see `docs/sharing.md`.
For first-line triage across auth/sync/restic/multipart/token failures, start
with `docs/troubleshooting.md`.

## Runbooks

- [Key rotation](./key-rotation.md)
- [Readonly maintenance windows](./readonly-maintenance.md)
- [Access policy split](./access-policy-split.md)
- [Incident response](./incident-response.md)
- [Web CSP and analytics](./web-csp-analytics.md)
- [Rollback of Worker/share configuration](./rollback-worker-share.md)
- [Rollback of CLI release](./rollback-cli-release.md)
- [Security gates remediation](./security-gates-remediation.md)

## Baseline prerequisites

- `wrangler` authenticated for the target account.
- Worker environment variables and KV bindings configured:
  - `R2E_SHARES_KV`
  - `R2E_KEYS_KV`
  - `R2E_READONLY`
- `r2` CLI available for Worker share lifecycle checks.
- Access to the deployment target for `https://files.unsigned.sh`.
