# Troubleshooting Matrix

This page is the first-stop triage reference for common failures across sync,
backup, and sharing workflows.

Use this format for each issue:

- `Failure signature`: what you observe.
- `Confirm`: commands to validate the failure.
- `Likely root causes`: highest-probability causes.
- `Repair`: command-level fix steps.
- `Verify`: expected post-fix behavior.
- `Escalate`: operator runbook if triage is not sufficient.

Credentials file convention:

- `/run/secrets/r2/credentials.env` rendered from `secrets/r2.yaml` via sops
  templates.

## 1) Authentication

### A. `rclone`/R2 auth fails (`403`, `SignatureDoesNotMatch`, or access denied)

Failure signature:

- `rclone lsf` or `r2 share` fails with authentication or signature errors.

Confirm:

```bash
set -a
source /run/secrets/r2/credentials.env
set +a

env | grep -E '^(R2_ACCOUNT_ID|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)='

rclone lsf :s3:files \
  --config=/dev/null \
  --s3-provider=Cloudflare \
  --s3-endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --s3-env-auth
```

Likely root causes:

- Missing or incorrect `R2_ACCOUNT_ID`.
- Invalid `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY`.
- Wrong credentials file path in `R2_CREDENTIALS_FILE`.

Repair:

```bash
# Use the intended credentials source explicitly
export R2_CREDENTIALS_FILE="${R2_CREDENTIALS_FILE:-/run/secrets/r2/credentials.env}"
set -a
source "${R2_CREDENTIALS_FILE}"
set +a
```

If values are still wrong, replace secret material in your managed secret source
and re-run the confirm command.

Verify:

- `rclone lsf` succeeds without auth/signature errors.
- `r2 share <bucket> <key>` returns a presigned URL.

Escalate:

- `docs/operators/incident-response.md` if failures continue after secret refresh.

### B. Worker admin auth fails (`401`/`403`) for `r2 share worker ...`

Failure signature:

- `r2 share worker create|list|revoke ...` returns unauthorized/forbidden.

Confirm:

```bash
env | grep -E '^(R2_EXPLORER_BASE_URL|R2_EXPLORER_ADMIN_KID|R2_EXPLORER_ADMIN_SECRET)='

r2 share worker list files workspace/demo.txt
```

Likely root causes:

- `R2_EXPLORER_ADMIN_KID` not present in `R2E_KEYS_KV`.
- `R2_EXPLORER_ADMIN_SECRET` mismatch for the configured key ID.
- Caller/Worker clock skew causing signature validation failures.

Repair:

```bash
# Refresh to current active key material
export R2_EXPLORER_ADMIN_KID="<active-kid>"
export R2_EXPLORER_ADMIN_SECRET="<matching-secret>"
```

If key mismatch persists, perform key rotation workflow.

Verify:

- `r2 share worker create ...` succeeds and returns a `shareUrl`.
- `r2 share worker list ...` returns token records.

Escalate:

- `docs/operators/key-rotation.md`
- `docs/operators/incident-response.md`

## 2) Lifecycle (`.trash` retention and delete behavior)

### A. Deleted files are not retained in `.trash`

Failure signature:

- After delete+bisync, deleted objects are missing from local/remote `.trash`.

Confirm:

```bash
echo "trash-check" | sudo tee /srv/r2/workspace/trash-check.txt >/dev/null
sudo systemctl start r2-bisync-workspace
sudo rm /srv/r2/workspace/trash-check.txt
sudo systemctl start r2-bisync-workspace

sudo ls -la /srv/r2/workspace/.trash

set -a
source /run/secrets/r2/credentials.env
set +a
rclone lsf :s3:files/.trash \
  --config=/dev/null \
  --s3-provider=Cloudflare \
  --s3-endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --s3-env-auth
```

Likely root causes:

- Bisync not using intended local or remote backup-dir path.
- Wrong mount/profile being checked (`documents` vs `workspace`).
- Sync run failed before delete propagation.

Repair:

```bash
# Re-run bisync and inspect service logs for backup-dir behavior
sudo systemctl start r2-bisync-workspace
sudo journalctl -u r2-bisync-workspace -n 100 --no-pager
```

If using minimal template, run equivalent `documents` unit/path checks.

Verify:

- Local `.trash` contains retained artifact.
- Remote `.trash` listing includes deleted file (or timestamped backup path).

Escalate:

- `docs/sync.md` for expected template defaults.
- `docs/operators/incident-response.md` if behavior regressed after deployment/config change.

### B. Bucket lifecycle policy not applied as expected

Failure signature:

- `.trash` data is not expiring as configured, or expected lifecycle rule missing.

Confirm:

```bash
wrangler r2 bucket lifecycle get files
```

Likely root causes:

- Lifecycle rules not deployed to target bucket.
- Rule exists on different bucket/environment than expected.

Repair:

- Reapply lifecycle configuration for the correct bucket/environment via Wrangler.
- Recheck policy output after apply.

Verify:

- `wrangler r2 bucket lifecycle get <bucket>` shows expected rules.

Escalate:

- `docs/operators/rollback-worker-share.md` if lifecycle drift followed deployment changes.

## 3) `rclone bisync`

### A. Bisync unit fails or reports state/lock conflicts

Failure signature:

- `r2-bisync-*` service exits non-zero.
- Logs mention lock/state mismatch, path not found, or repeated conflicts.

Confirm:

```bash
sudo systemctl status r2-bisync-workspace
sudo journalctl -u r2-bisync-workspace -n 200 --no-pager
sudo systemctl list-timers | grep r2-bisync-workspace
```

Likely root causes:

- Local sync path missing or permissions changed.
- Concurrent/manual runs overlapping timer execution.
- Previous failed run left bisync state inconsistent.

Repair:

```bash
# Ensure path exists and is writable by the service context
sudo mkdir -p /srv/r2/workspace
sudo systemctl restart r2-mount-workspace

# Retry a single controlled run
sudo systemctl start r2-bisync-workspace
```

If overlap is suspected, stop active run before retrying:

```bash
sudo systemctl stop r2-bisync-workspace
sudo systemctl start r2-bisync-workspace
```

Verify:

- Service exits successfully.
- Timer remains scheduled.
- Remote and local deltas reconcile.

Escalate:

- `docs/sync.md` for template-specific expected paths.

## 4) `restic`

### A. Backup unit fails (`repository does not exist`, auth failure, wrong password)

Failure signature:

- `r2-restic-backup` fails and snapshots are not created.

Confirm:

```bash
sudo systemctl status r2-restic-backup
sudo journalctl -u r2-restic-backup -n 200 --no-pager

set -a
source /run/secrets/r2/credentials.env
set +a
export RESTIC_PASSWORD_FILE=/run/secrets/r2/restic-password

restic -r "s3:https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/backups" snapshots
```

Likely root causes:

- Missing or wrong `RESTIC_PASSWORD_FILE`.
- Repository bucket/path mismatch.
- Invalid R2 credentials.

Repair:

```bash
# Confirm password file exists and is readable
sudo test -r /run/secrets/r2/restic-password

# If repository is not initialized yet:
restic -r "s3:https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/backups" init

# Retry scheduled unit
sudo systemctl start r2-restic-backup
```

Verify:

- `restic snapshots` lists snapshot entries.
- `r2-restic-backup` exits successfully.

Escalate:

- `docs/versioning.md` for expected repository defaults.
- `docs/operators/incident-response.md` if failures began after secret/key changes.

## 5) Multipart upload (Worker API)

### A. `upload/init|part|complete` fails or returns invalid upload state

Failure signature:

- Worker upload endpoints return 4xx/5xx, or `complete` fails after parts upload.

Confirm:

```bash
# Validate API protection and worker reachability
curl -I https://files.example.com/api/server/info
curl -I https://files.example.com/api/upload/init
```

For authenticated test sessions, retry init/part/complete sequence and capture
response body/status for each step.

Likely root causes:

- Missing Access session or admin auth where required.
- Mismatched upload ID/part list between `part` and `complete`.
- Deployment drift causing schema/contract mismatch.

Repair:

- Restart the upload sequence from a fresh `upload/init`.
- Ensure each part upload uses the same upload ID and correct part numbering.
- If stuck upload state persists, call `upload/abort` and retry from init.
- Redeploy Worker if mismatch started after code/config rollout.

Verify:

- New multipart sequence completes successfully.
- Uploaded object is retrievable from expected key.

Escalate:

- `docs/operators/rollback-worker-share.md`
- `docs/operators/incident-response.md`

## 6) Token validation (`/share/<token>`)

### A. Share URL returns unauthorized/not found despite recent token creation

Failure signature:

- `GET /share/<token-id>` returns `401`, `403`, `404`, or unexpected Access redirect.

Confirm:

```bash
curl -I https://files.example.com/share/<token-id>
curl -I https://files.example.com/api/list
r2 share worker list files workspace/demo.txt
```

Likely root causes:

- Token expired/revoked/or max-downloads exceeded.
- `R2E_SHARES_KV` binding mismatch in active deployment.
- Access policy split drift (`/share/*` no longer bypassed).

Repair:

```bash
# Mint a fresh token and retest immediately
r2 share worker create files workspace/demo.txt 1h --max-downloads 1
```

If fresh token still fails, re-validate Access split for:

- `/*` Allow (org identities)
- `/share/*` Bypass

Verify:

- Fresh `shareUrl` is reachable publicly.
- `/api/*` remains Access-protected.

Escalate:

- `docs/operators/access-policy-split.md`
- `docs/operators/rollback-worker-share.md`
- `docs/operators/incident-response.md`
