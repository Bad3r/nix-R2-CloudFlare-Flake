# Versioning

This page covers the versioning workflows used by the `templates/full` profile.

## Restic snapshots (`services.r2-restic`)

Template defaults:

- bucket: `backups`
- paths: `/srv/r2/workspace`
- timer unit: `r2-restic-backup.timer`
- service unit: `r2-restic-backup.service`

Verify timer and service wiring:

```bash
sudo systemctl status r2-restic-backup
sudo systemctl list-timers | grep r2-restic-backup
```

Run an immediate backup:

```bash
sudo systemctl start r2-restic-backup
```

Expected result:

- restic creates snapshot(s)
- retention policy runs in the same unit invocation

## git-annex content workflow (`programs.git-annex-r2`)

The full template installs `git-annex-r2-init` and sets defaults:

- rclone remote name: `r2`
- default bucket hint: `files`
- default prefix: `annex/workspace`

Initialize a repository remote:

```bash
mkdir -p ~/tmp/annex-demo
cd ~/tmp/annex-demo
git init

git-annex-r2-init
```

Track and sync content:

```bash
git annex add large-file.bin
git commit -m "Track large file with git-annex"
git annex sync --content
```

Selective fetch/drop cycle:

```bash
git annex drop large-file.bin
git annex get large-file.bin
```

Expected result:

- annex metadata remains in git
- file content is pushed/pulled via the R2-backed special remote
