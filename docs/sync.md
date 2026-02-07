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
