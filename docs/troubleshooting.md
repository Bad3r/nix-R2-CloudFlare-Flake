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

Note on permissions:

- Read-only checks (`systemctl status`, `journalctl -u`, `test -r`) are written
  without `sudo` here. If your host restricts these, prefix with `sudo`.

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
- `r2 share worker ...` can also fail with `HTTP 302` when Access intercepts
  `/api/share/*` before the Worker.

Confirm:

```bash
# Managed deployments often provide Worker admin signing inputs via a system
# env file (so your interactive shell may NOT have these exported).
test -r /run/secrets/r2/explorer.env
grep -E '^(R2_EXPLORER_BASE_URL|R2_EXPLORER_ADMIN_KID)=' /run/secrets/r2/explorer.env
grep -q '^R2_EXPLORER_ADMIN_SECRET=' /run/secrets/r2/explorer.env

r2 share worker list files workspace/demo.txt
```

Likely root causes:

- `R2_EXPLORER_ADMIN_KID` not present in `R2E_KEYS_KV`.
- `R2_EXPLORER_ADMIN_SECRET` mismatch for the configured key ID.
- Caller/Worker clock skew causing signature validation failures.
- KV was updated locally (missing `wrangler kv ... --remote`), so the deployed
  Worker keyset never actually changed.
- `/api/share/*` is Access-protected and CLI calls do not include Access
  service-token headers.

Repair:

```bash
# Refresh to current active key material.
# For managed NixOS, prefer updating the SOPS-managed source of truth and
# rebuilding so `/run/secrets/r2/explorer.env` is updated persistently.
#
# For ad-hoc testing only:
export R2_EXPLORER_ADMIN_KID="<active-kid>"
export R2_EXPLORER_ADMIN_SECRET="<matching-secret>"
# Optional when /api/share/* is behind Access:
export R2_EXPLORER_ACCESS_CLIENT_ID="<access-service-token-id>"
export R2_EXPLORER_ACCESS_CLIENT_SECRET="<access-service-token-secret>"
```

If key mismatch persists, perform key rotation workflow.

Verify:

- `r2 share worker create ...` succeeds and returns a `url`.
- `r2 share worker list ...` returns token records.

Escalate:

- `docs/operators/key-rotation.md`
- `docs/operators/incident-response.md`

### C. `access_jwt_invalid` caused by JWKS infrastructure failure

Failure signature:

- All `/api/*` requests return `401` with code `access_jwt_invalid`.
- Multiple users affected simultaneously.
- Previously-working tokens rejected.

Confirm:

```bash
curl -sS "https://<team-domain>.cloudflareaccess.com/cdn-cgi/access/certs" | jq '.keys | length'
```

Likely root causes:

- Cloudflare Access JWKS endpoint unavailable or returning errors.
- DNS resolution failure for the team domain from the Worker runtime.

Note: The Worker returns `401` (not `502`/`503`) for JWKS fetch failures as a
fail-closed security posture. All infrastructure errors during JWT validation
surface as `access_jwt_invalid` to avoid leaking internal state.

Repair:

- Check [Cloudflare Status](https://www.cloudflarestatus.com/) for Access incidents.
- Verify JWKS endpoint reachable from a separate network.
- If team domain changed, update `R2E_ACCESS_TEAM_DOMAIN` and redeploy.

Verify:

- JWKS endpoint returns JSON with non-empty `keys` array.
- `/api/server/info` with valid Access credentials returns `200`.

Escalate:

- `docs/operators/incident-response.md`

## 2) Lifecycle (`.trash` retention and delete behavior)

### A. Deleted files are not retained in `.trash`

Failure signature:

- After delete+bisync, deleted objects are missing from local/remote `.trash`.

Confirm:

```bash
printf '%s\n' "trash-check" > /data/r2/workspace/trash-check.txt
sudo systemctl start r2-bisync-workspace
rm /data/r2/workspace/trash-check.txt
sudo systemctl start r2-bisync-workspace

ls -la /data/r2/.trash/workspace

set -a
source /run/secrets/r2/credentials.env
set +a
rclone lsf :s3:nix-r2-cf-r2e-files-prod/.trash/workspace \
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
wrangler r2 bucket lifecycle list files
```

Likely root causes:

- Lifecycle rules not deployed to target bucket.
- Rule exists on different bucket/environment than expected.

Repair:

- Reapply lifecycle configuration for the correct bucket/environment via Wrangler.
- Use explicit rule operations to avoid replacing unrelated rules:

```bash
# Add or update the .trash retention rule
wrangler r2 bucket lifecycle add files trash-cleanup .trash/ --expire-days 30 --force

# Remove a specific lifecycle rule by id
wrangler r2 bucket lifecycle remove files --name trash-cleanup
```

- Recheck policy output after apply.

Verify:

- `wrangler r2 bucket lifecycle list <bucket>` shows expected rules.

Escalate:

- `docs/operators/rollback-worker-share.md` if lifecycle drift followed deployment changes.

## 3) `rclone bisync`

### A. Bisync unit fails or reports state/lock conflicts

Failure signature:

- `r2-bisync-*` service exits non-zero.
- Logs mention lock/state mismatch, path not found, or repeated conflicts.

Confirm:

```bash
systemctl status r2-bisync-workspace --no-pager
journalctl -u r2-bisync-workspace -n 200 --no-pager
systemctl list-timers | grep r2-bisync-workspace
```

Likely root causes:

- Local sync path missing or permissions changed.
- Concurrent/manual runs overlapping timer execution.
- Previous failed run left bisync state inconsistent.

Repair:

```bash
# Ensure path exists and is writable by the service context
sudo systemd-tmpfiles --create
sudo systemctl restart r2-mount-workspace

# Retry a single controlled run
sudo systemctl start r2-bisync-workspace
```

If logs say `Must run --resync to recover`, reset bisync state (safe: it only
removes rclone's listing cache, not your data):

```bash
sudo systemctl stop r2-bisync-workspace.timer r2-bisync-workspace.service
rm -f /var/lib/r2-sync-workspace/bisync/*.lst*
sudo systemctl start r2-bisync-workspace.service
sudo systemctl start r2-bisync-workspace.timer
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
systemctl status r2-restic-backup --no-pager
journalctl -u r2-restic-backup -n 200 --no-pager

set -a
source /run/secrets/r2/credentials.env
set +a
export RESTIC_PASSWORD_FILE=/run/secrets/r2/restic-password

restic -r "s3:https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/nix-r2-cf-backups-prod" snapshots
```

Likely root causes:

- Missing or wrong `RESTIC_PASSWORD_FILE`.
- Repository bucket/path mismatch.
- Invalid R2 credentials.

Repair:

```bash
# Confirm password file exists and is readable
test -r /run/secrets/r2/restic-password

# If repository is not initialized yet:
restic -r "s3:https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/nix-r2-cf-backups-prod" init

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

### A. `upload/init|sign-part|complete` fails or returns invalid upload state

Failure signature:

- Worker upload control-plane endpoints return 4xx/5xx, or `complete` fails after direct part uploads.

Confirm:

```bash
# Validate API protection and worker reachability
curl -I https://files.unsigned.sh/api/server/info
curl -I https://files.unsigned.sh/api/upload/init
```

For authenticated test sessions, retry init/sign-part/complete sequence and
capture response body/status for each step. For direct uploads, also capture
the R2 `PUT` status and response headers (especially `ETag`).

Likely root causes:

- Missing Access session or admin auth where required.
- Mismatched upload session or part list between `sign-part` and `complete`.
- Missing/incorrect bucket CORS configuration for browser direct uploads.
- Presigned part URL expired before client `PUT` request.
- Deployment drift causing schema/contract mismatch.

Repair:

- Restart the upload sequence from a fresh `upload/init`.
- Ensure each part request uses the same `sessionId` + `uploadId` and correct part numbering.
- Confirm direct upload requests target `https://<account_id>.r2.cloudflarestorage.com/...`.
- Confirm bucket CORS allows the app origin, `PUT`, and exposes `ETag`.
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
curl -I https://files.unsigned.sh/share/<token-id>
curl -I https://files.unsigned.sh/share/<token-id>
curl -I https://files.unsigned.sh/api/list
r2 share worker list files workspace/demo.txt
```

Likely root causes:

- Token expired/revoked/or max-downloads exceeded.
- `R2E_SHARES_KV` binding mismatch in active deployment.
- Access policy split drift (`/share/*` no longer bypassed).
- Bucket alias missing from `R2E_BUCKET_MAP` or binding missing for the stored bucket.

Repair:

```bash
# Mint a fresh token and retest immediately
r2 share worker create files workspace/demo.txt 1h --max-downloads 1
```

If the bucket mapping is suspect, verify Worker settings:

```bash
curl -s https://files.unsigned.sh/api/server/info | jq '.buckets'
```

If fresh token still fails, re-validate Access split for:

- `/*` Allow (org identities)
- `/share/*` Bypass

Verify:

- Fresh `url` is reachable publicly.
- `/api/*` remains Access-protected.

Escalate:

- `docs/operators/access-policy-split.md`
- `docs/operators/rollback-worker-share.md`
- `docs/operators/incident-response.md`
