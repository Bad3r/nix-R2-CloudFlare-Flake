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

### B. Worker auth fails (`401`/`403`) for API/CLI or browser UI

Failure signature:

- `r2 share worker create|list|revoke ...` returns unauthorized/forbidden.
- `/api/v2/*` calls fail with `access_required`, `token_invalid_signature`,
  `token_claim_mismatch`, or `insufficient_scope`.
- Browser preview/download (`/api/v2/preview`, `/api/v2/download`) opens an
  Access login redirect or returns `401` in a new tab.

Confirm:

```bash
# Managed deployments often provide Worker API credentials via a system env
# file (so your interactive shell may NOT have these exported).
test -r /run/secrets/r2/explorer.env
grep -E '^(R2_EXPLORER_BASE_URL|R2_EXPLORER_ACCESS_CLIENT_ID)=' /run/secrets/r2/explorer.env
grep -q '^R2_EXPLORER_ACCESS_CLIENT_SECRET=' /run/secrets/r2/explorer.env

r2 share worker list files workspace/demo.txt
```

Likely root causes:

- Missing/incorrect Access service-token credentials in
  `R2_EXPLORER_ACCESS_CLIENT_ID` / `R2_EXPLORER_ACCESS_CLIENT_SECRET`.
- Access policy drift on `/api/v2/*` (missing Service Auth policy, unexpected
  bypass policy, or wrong app host).
- Access JWT `aud` claim does not match `R2E_ACCESS_AUD`.
- Token lacks required route scope when `R2E_ACCESS_REQUIRED_SCOPES*` is set.
- Browser has no valid Access session and needs `/cdn-cgi/access/login`.

Repair:

```bash
# For managed NixOS, prefer updating the SOPS-managed source of truth and
# rebuilding so `/run/secrets/r2/explorer.env` is updated persistently.
# Replace files.example.com with your deployment's own domain.
export R2_EXPLORER_BASE_URL="https://files.example.com"
export R2_EXPLORER_ACCESS_CLIENT_ID="<service-token-client-id>"
export R2_EXPLORER_ACCESS_CLIENT_SECRET="<service-token-client-secret>"

# Fast Access service-token probe:
curl -i \
  -H "CF-Access-Client-Id: ${R2_EXPLORER_ACCESS_CLIENT_ID}" \
  -H "CF-Access-Client-Secret: ${R2_EXPLORER_ACCESS_CLIENT_SECRET}" \
  "${R2_EXPLORER_BASE_URL%/}/api/v2/session/info"
```

Verify:

- `r2 share worker create ...` succeeds and returns a `url`.
- `r2 share worker list ...` returns token records.
- Browser web UI can list objects and open preview/download without `401`.

Escalate:

- `docs/operators/incident-response.md`

### C. `token_invalid_signature` caused by JWKS infrastructure failure

Failure signature:

- All `/api/v2/*` requests return `401` with code `token_invalid_signature`.
- Multiple users affected simultaneously.
- Previously-working tokens rejected.

Confirm:

```bash
team_domain="${R2E_ACCESS_TEAM_DOMAIN:-repo.cloudflareaccess.com}"
team_origin="${team_domain%/}"
if [[ ${team_origin} != https://* ]]; then
  team_origin="https://${team_origin#http://}"
fi
curl -sS "${team_origin}/cdn-cgi/access/certs" | jq '.keys | length'
```

Likely root causes:

- Cloudflare Access cert endpoint unavailable or returning invalid payload.
- DNS/TLS failures reaching the configured `R2E_ACCESS_JWKS_URL` (or team domain
  default cert endpoint).

Note: The Worker returns `401` (not `502`/`503`) for JWKS fetch failures as a
fail-closed security posture. All infrastructure errors during JWT validation
surface as `token_invalid_signature` to avoid leaking internal state.

Repair:

- Check Cloudflare Access status for upstream incidents.
- Verify JWKS endpoint reachable from a separate network.
- If Access domain/endpoint changed, update `R2E_ACCESS_TEAM_DOMAIN` /
  `R2E_ACCESS_JWKS_URL` and redeploy.

Verify:

- JWKS endpoint returns JSON with non-empty `keys` array.
- `/api/v2/session/info` with valid bearer credentials returns `200`.

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
rclone lsf :s3:files/.trash/workspace \
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

If logs say `Must run --resync to recover`, the service now retries once with
`--resync` automatically when stale listing basenames are detected. If it still
fails, archive bisync state and run a controlled resync (safe: this only moves
rclone listing cache files, not your data):

```bash
sudo systemctl stop r2-bisync-workspace.timer r2-bisync-workspace.service
sudo bash -c '
  set -euo pipefail
  shopt -s nullglob
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  archive="/var/lib/r2-sync-workspace/bisync/archive-${ts}"
  install -d -m 0750 "$archive"
  for f in /var/lib/r2-sync-workspace/bisync/*.lst*; do
    mv "$f" "$archive/"
  done
'
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

### B. First run of a large prefix takes a long time

Failure signature:

- The first run of `r2-bisync-<name>` runs for a very long time, with little
  CPU, no disk writes, and steady small-request network traffic.
- A run that outlasts `bisync.timeout` (default `24h`; see
  `docs/reference/services-r2-sync.md`, "Service timeouts") is stopped
  (`start operation timed out. Terminating.`), and
  `/var/lib/r2-sync-<name>/bisync/` holds only `.lst-new` headers and a `.lck`
  after the kill; the next timer run clears the orphaned lock and starts
  over, so a first run that always needs longer never completes.

Confirm:

```bash
journalctl -u r2-bisync-<name> -n 50 --no-pager
ls -la /var/lib/r2-sync-<name>/bisync/
find <localPath> -type f | wc -l
find <localPath> -type f -path '*/node_modules/*' -o -type f -path '*/.venv/*' | wc -l
```

Likely root causes:

- rclone's default comparison is `size,modtime`. On S3-class backends the
  modtime lives in object metadata, so every listing costs one HEAD request per
  object, and bisync writes its listings only after the whole walk finishes.
  Every later run pays this cost again.
- Build and dependency trees (`node_modules`, `.venv`, caches) dominate the
  object count and do not belong in the sync.

Repair (see `docs/reference/services-r2-sync.md`, "Sizing a mount for a large
prefix", to make the run itself faster):

```nix
services.r2-sync.mounts.<name>.bisync = {
  compare = "size,checksum";
  excludes = [ "node_modules/**" ".venv/**" ];
  extraArgs = [ "--fast-list" "--checkers" "16" ];
};
```

A `compare` or `excludes` change on a mount that already has listing state
makes the next run perform one automatic `--resync`, which rclone requires
after a filter change. So does a change to a size, age, depth, hash, metadata
or `--ignore-case` filter in `extraArgs`; pattern filters are rejected there,
so keep them in `excludes`. Reordering `excludes` or those `extraArgs` filters
triggers the resync too, since the module records them in the order given.

When the tuned first run still needs more than `bisync.timeout`, raise the
deadline for that mount, or set `""` for no limit until the first run has
seeded its listings. Set the option rather than
`systemd.services."r2-bisync-<name>".serviceConfig.TimeoutStartSec`, which
conflicts with the value the module derives from it:

```nix
services.r2-sync.mounts.<name>.bisync.timeout = "72h";
```

Verify:

- The first run after the change completes and `journalctl` shows a
  `Bisync successful` line.
- `/var/lib/r2-sync-<name>/bisync/` contains `.lst` files and
  `.r2-bisync-flags` listing the configured `--compare` flag and exclude filter
  rules.

### C. Bisync aborts with a max-delete safety message

Failure signature:

- `r2-bisync-<name>` exits non-zero and the log shows a line similar to
  `Safety abort: too many deletes (>NN%, X of Y) ... Run with --force if
desired.`

Confirm:

```bash
journalctl -u r2-bisync-<name> -n 100 --no-pager | grep -i "safety abort\|too many deletes"
```

Likely root causes:

- `services.r2-sync.mounts.<name>.bisync.maxDelete` (default `50`, rclone's
  own default) is a PERCENTAGE of tracked files, 0 to 100, not a count. When a
  run would delete more than that share of files on either side, for example
  because a listing came back empty, bisync aborts the whole run before
  changing anything on either side.

Repair:

- Inspect both `localPath` and the remote bucket/prefix to confirm whether
  the mass delete is actually intended.
- If it is intended, run the unit's own bisync command once by hand with
  `--force` (same `--workdir`, `--backup-dir1`, `--backup-dir2`, and
  local/remote paths as the generated unit).
- If large deletes are routine for this mount, raise
  `services.r2-sync.mounts.<name>.bisync.maxDelete` instead of forcing every
  run.

Verify:

- The next scheduled run of `r2-bisync-<name>` completes without the
  max-delete abort.

Escalate:

- `docs/reference/services-r2-sync.md` for the full `maxDelete` semantics.

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

restic -r "s3:https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/backups" snapshots
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

### B. `r2-restic-backup.service` shows failed with exit status `3`

Failure signature:

- `systemctl status r2-restic-backup` reports `failed` with exit status `3`,
  but a new snapshot exists.

Confirm:

```bash
systemctl status r2-restic-backup --no-pager
journalctl -u r2-restic-backup -n 200 --no-pager

set -a
source /run/secrets/r2/credentials.env
set +a
export RESTIC_PASSWORD_FILE=/run/secrets/r2/restic-password

restic -r "s3:https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/backups" snapshots
```

Likely root causes:

- Exit `3` means restic could not read one or more source files during the
  backup. The backup script still completes the run: a snapshot is created
  from whatever it could read, and `unlock`/`forget --prune` still ran, so
  retention is unaffected. Only the exit status flags the unit as failed.

Repair:

- Read the journal for the specific unreadable path(s) restic reported.
- Fix the permission or existence problem, or add the path to
  `services.r2-restic.exclude` if it should never be backed up.

Verify:

- The next scheduled `r2-restic-backup` run exits `0` and
  `systemctl status r2-restic-backup` reports success.

Escalate:

- `docs/reference/services-r2-restic.md` for the full exit-code handling.

## 5) Multipart upload (Worker API)

### A. `upload/init|sign-part|complete` fails or returns invalid upload state

Failure signature:

- Worker upload control-plane endpoints return 4xx/5xx, or `complete` fails after direct part uploads.

Confirm:

```bash
# Validate API protection and worker reachability
curl -I https://files.example.com/api/v2/session/info
curl -I https://files.example.com/api/v2/upload/init
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
- Reapply upload bucket CORS (same payload used by CI deploy jobs):

```bash
# Example: replace with your own bucket and domain
./scripts/ci/sync-r2-upload-cors.sh \
  files \
  "${R2E_UPLOAD_ALLOWED_ORIGINS:-}" \
  "https://files.example.com"
```

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
curl -I https://files.example.com/share/<token-id>
curl -I https://files.example.com/api/v2/list
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
curl -s https://files.example.com/api/v2/session/info | jq '.buckets'
```

If fresh token still fails, re-validate Access split for:

- `/*` Allow (org identities)
- `/share/*` Bypass

Verify:

- Fresh `url` is reachable publicly.
- `/api/v2/*` remains Access-protected.

Escalate:

- `docs/operators/access-policy-split.md`
- `docs/operators/rollback-worker-share.md`
- `docs/operators/incident-response.md`

## 7) Evaluation and platform

### A. `nix flake check`/`nixos-rebuild` fails with a `services.r2-sync` assertion

Failure signature:

- Evaluation aborts before any unit is generated, naming `services.r2-sync`
  and a condition such as `localPath` equal to `mountPoint`, two mounts
  overlapping, an invalid mount name, or a filter flag inside
  `bisync.extraArgs`.

Confirm:

- Read the full assertion message; it names the exact mount and option.

Likely root causes:

- The configuration violates one of the module's fail-fast checks: wrong
  `localPath`, two mounts targeting the same bucket/prefix or overlapping
  paths, a mount name outside `[A-Za-z0-9_.-]+` (or exactly `.` or `..`), a
  `--filter`-shaped flag passed through `extraArgs` instead of
  `bisync.excludes`, `--delete-excluded` in `extraArgs`, or a `bisync.timeout`
  or `syncInterval` that is not a `systemd.time(7)` time span.

Repair:

- Match the printed message against the "Failure semantics" section of
  `docs/reference/services-r2-sync.md`, which lists every current assertion,
  and fix the named option accordingly; assertion wording can change between
  revisions, so treat the reference page, not a remembered message string, as
  the source of truth.

Verify:

- `nix flake check` (or the next `nixos-rebuild` evaluation) completes past
  the module's assertion checks.

Escalate:

- `docs/reference/services-r2-sync.md`, "Failure semantics".

### B. Intel macOS (`x86_64-darwin`) fails to evaluate or is missing from flake outputs

Failure signature:

- `nix build`, `nix develop`, `nix flake check`, or `nix flake show` for
  `x86_64-darwin` fails, for example with `Nixpkgs ... has dropped support
for x86_64-darwin`, or the system is simply absent from `nix flake show`'s
  output.

Likely root causes:

- Intel macOS (`x86_64-darwin`) is no longer a supported system of this
  flake.

Repair:

- Run the command on a supported system instead: `x86_64-linux`,
  `aarch64-linux`, or `aarch64-darwin` (Apple Silicon).

Verify:

- The same command succeeds on one of the supported systems above.

## 8) Object operations (web/API)

### A. Upload or move returns `409 object_exists`

Failure signature:

- An upload or move through the web UI or `/api/v2/*` fails with HTTP `409`
  and code `object_exists`.

Likely root causes:

- The target key already exists. Uploads and moves do not silently
  overwrite; the caller must confirm the overwrite first.

Repair:

- In the web UI, confirm the overwrite; a copy of the previous object is kept
  under `.trash/`, so it is not lost.
- Via the API, follow the overwrite-confirmation flow for the endpoint in
  use, or choose another destination key.

Verify:

- The upload or move completes and the previous object is visible under
  `.trash/`.

Escalate:

- `docs/sharing.md` for the Worker API contract.

### B. A key with a space returns `404 object_not_found`

Failure signature:

- A request built with a raw (non-percent-encoded) object key containing a
  space returns `404 object_not_found`, even though the object exists.

Likely root causes:

- Object keys used in query strings must be percent-encoded with
  `encodeURIComponent`. A literal `+` in a raw query string decodes as a
  space, so a key built by hand instead of through `encodeURIComponent` never
  matches the stored key.

Repair:

- Percent-encode the key with `encodeURIComponent` (or equivalent) before
  building the request URL, so a space becomes `%20` rather than `+`.

Verify:

- The same request with a correctly percent-encoded key returns the object.

Escalate:

- `docs/sharing.md` for the Worker API contract.
