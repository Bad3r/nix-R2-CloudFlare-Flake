# Sync

This page validates the sync flows defined by the repository templates.
Use only the commands for the template you deployed (`minimal` or `full`).

Option reference: `docs/reference/index.md` and `docs/reference/services-r2-sync.md`.
If any step fails, use `docs/troubleshooting.md` for command-level diagnosis and
repair paths.

Credentials are expected at `/run/secrets/r2/credentials.env`, rendered from
`secrets/r2.yaml` via sops templates.

## Concepts: mirror vs mount

`services.r2-sync` supports two related but distinct workflows:

- **Bisync mirror** (`localPath`): a real local directory which is two-way
  synchronized to R2 on a timer. This is the Dropbox-style “shared folder” you
  should edit.
- **FUSE mount** (`mountPoint`): a live view of the remote R2 prefix mounted via
  `rclone mount`. It can cache/stage data locally (see `vfsCache.*`) and is best
  treated as an inspection/occasional-access path, not the primary working copy.

## Minimal template (`documents` mount)

Template defaults:

- mount name: `documents`
- bucket: `documents`
- remote prefix: `documents`
- mount point: `/data/r2/mount/documents`
- local bisync path: `/data/r2/documents`

Recommended workflow: edit `/data/r2/documents` (bisync mirror).

Verify services:

```bash
sudo systemctl status r2-mount-documents
sudo systemctl status r2-bisync-documents
sudo systemctl list-timers | grep r2-bisync-documents
```

Trigger sync manually:

```bash
sudo systemctl start r2-bisync-documents
```

Expected result:

- bisync service exits successfully
- `.trash/` paths are used for delete backup behavior on both sides
  - local: `/data/r2/.trash/documents`
  - remote: `:s3:documents/.trash/documents`

Remote checkpoint:

```bash
set -a
source /run/secrets/r2/credentials.env
set +a

rclone lsf :s3:documents/documents \
  --config=/dev/null \
  --s3-provider=Cloudflare \
  --s3-endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --s3-env-auth
```

Expected result:

- remote bucket listing succeeds with no authentication errors

Delete/backup-dir checkpoint:

```bash
printf '%s\n' "sync-check" > /data/r2/documents/sync-check.txt
sudo systemctl start r2-bisync-documents
rm /data/r2/documents/sync-check.txt
sudo systemctl start r2-bisync-documents

ls -la /data/r2/.trash/documents
rclone lsf :s3:documents/.trash/documents \
  --config=/dev/null \
  --s3-provider=Cloudflare \
  --s3-endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --s3-env-auth
```

Expected result:

- deleted file is retained in local `.trash/`
- deleted file (or its timestamped backup path) appears under remote `.trash/`

## Full template (`workspace` mount)

Template defaults:

- mount name: `workspace`
- bucket: `files`
- remote prefix: `workspace`
- mount point: `/data/r2/mount/workspace`
- local bisync path: `/data/r2/workspace`

Recommended workflow: edit `/data/r2/workspace` (bisync mirror).

Verify services:

```bash
sudo systemctl status r2-mount-workspace
sudo systemctl status r2-bisync-workspace
sudo systemctl list-timers | grep r2-bisync-workspace
```

Trigger sync manually:

```bash
sudo systemctl start r2-bisync-workspace
```

Expected result:

- local and remote deltas reconcile through `rclone bisync`
- deletions are redirected to `.trash/` backup dirs

Remote checkpoint:

```bash
set -a
source /run/secrets/r2/credentials.env
set +a

rclone lsf :s3:files/workspace \
  --config=/dev/null \
  --s3-provider=Cloudflare \
  --s3-endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --s3-env-auth
```

Expected result:

- remote bucket listing succeeds with no authentication errors

Delete/backup-dir checkpoint:

```bash
printf '%s\n' "sync-check" > /data/r2/workspace/sync-check.txt
sudo systemctl start r2-bisync-workspace
rm /data/r2/workspace/sync-check.txt
sudo systemctl start r2-bisync-workspace

ls -la /data/r2/.trash/workspace
rclone lsf :s3:files/.trash/workspace \
  --config=/dev/null \
  --s3-provider=Cloudflare \
  --s3-endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --s3-env-auth
```

Expected result:

- deleted file is retained in local `.trash/`
- deleted file (or its timestamped backup path) appears under remote `.trash/`
