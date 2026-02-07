# Sync

`services.r2-sync` is implemented and provides:

- `rclone mount` systemd services per configured mount
- `rclone bisync` services and timers
- `.trash/` lifecycle compatibility for soft-delete recovery workflows

Typical consumer-side checks:

```bash
sudo systemctl status r2-mount-<name>
sudo systemctl status r2-bisync-<name>
sudo systemctl list-timers | grep r2-bisync
```

Manual sync trigger:

```bash
sudo systemctl start r2-bisync-<name>
```
