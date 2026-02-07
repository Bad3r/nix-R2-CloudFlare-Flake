# Versioning

Versioning-related components are implemented:

- `services.r2-restic` for scheduled snapshots and retention policy enforcement
- `modules/nixos/git-annex.nix` for git-annex + R2 remote workflows

Restic verification examples:

```bash
sudo systemctl status r2-restic-backup
sudo systemctl list-timers | grep r2-restic
```

git-annex helper usage:

```bash
git-annex-r2-init
git annex add <large-file>
git annex sync --content
```
