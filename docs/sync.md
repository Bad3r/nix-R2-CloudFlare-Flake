# Sync

This page validates the sync flows defined by the repository templates.

Option reference: `docs/reference/index.md` and `docs/reference/services-r2-sync.md`.

## Minimal template (`documents` mount)

Template defaults:

- mount name: `documents`
- bucket: `documents`
- mount point: `/mnt/r2/documents`
- local bisync path: `/var/lib/r2-sync/documents`

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

Remote checkpoint:

```bash
set -a
source /run/secrets/r2-credentials
set +a

rclone lsf :s3:documents \
  --config=/dev/null \
  --s3-provider=Cloudflare \
  --s3-endpoint="https://<account-id>.r2.cloudflarestorage.com" \
  --s3-env-auth
```

Expected result:

- remote bucket listing succeeds with no authentication errors

Delete/backup-dir checkpoint:

```bash
echo "sync-check" | sudo tee /var/lib/r2-sync/documents/sync-check.txt >/dev/null
sudo systemctl start r2-bisync-documents
sudo rm /var/lib/r2-sync/documents/sync-check.txt
sudo systemctl start r2-bisync-documents

sudo ls -la /var/lib/r2-sync/documents/.trash
rclone lsf :s3:documents/.trash \
  --config=/dev/null \
  --s3-provider=Cloudflare \
  --s3-endpoint="https://<account-id>.r2.cloudflarestorage.com" \
  --s3-env-auth
```

Expected result:

- deleted file is retained in local `.trash/`
- deleted file (or its timestamped backup path) appears under remote `.trash/`

## Full template (`workspace` mount)

Template defaults:

- mount name: `workspace`
- bucket: `files`
- mount point: `/mnt/r2/workspace`
- local bisync path: `/srv/r2/workspace`

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
source /run/secrets/r2-credentials
set +a

rclone lsf :s3:files \
  --config=/dev/null \
  --s3-provider=Cloudflare \
  --s3-endpoint="https://<account-id>.r2.cloudflarestorage.com" \
  --s3-env-auth
```

Expected result:

- remote bucket listing succeeds with no authentication errors

Delete/backup-dir checkpoint:

```bash
echo "sync-check" | sudo tee /srv/r2/workspace/sync-check.txt >/dev/null
sudo systemctl start r2-bisync-workspace
sudo rm /srv/r2/workspace/sync-check.txt
sudo systemctl start r2-bisync-workspace

sudo ls -la /srv/r2/workspace/.trash
rclone lsf :s3:files/.trash \
  --config=/dev/null \
  --s3-provider=Cloudflare \
  --s3-endpoint="https://<account-id>.r2.cloudflarestorage.com" \
  --s3-env-auth
```

Expected result:

- deleted file is retained in local `.trash/`
- deleted file (or its timestamped backup path) appears under remote `.trash/`
