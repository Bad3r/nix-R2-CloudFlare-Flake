# `services.r2-sync` Reference

Provides rclone mount + bisync services/timers for one or more R2 buckets.

Activation condition: `services.r2-sync.enable = true`.

Credentials are expected in `/run/secrets/r2/credentials.env` (rendered from
`secrets/r2.yaml` via sops templates).

## Options

| Option                                                    | Type                                                         | Default       | Required when enabled                 | Notes                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------ | ------------- | ------------------------------------- | ------------------------------------------------------------- |
| `services.r2-sync.enable`                                 | boolean                                                      | `false`       | no                                    | Enables service and timer generation.                         |
| `services.r2-sync.credentialsFile`                        | `null` or path                                               | `null`        | yes                                   | Environment file loaded by systemd units.                     |
| `services.r2-sync.accountId`                              | string                                                       | `""`          | yes (if file unset)                   | Used to build `https://<accountId>.r2.cloudflarestorage.com`. |
| `services.r2-sync.accountIdFile`                          | `null` or path                                               | `null`        | yes (if literal unset)                | File-based account ID source.                                 |
| `services.r2-sync.mounts`                                 | attrset of submodules                                        | `{}`          | yes (must contain at least one mount) | One mount profile per attr key.                               |
| `services.r2-sync.mounts.<name>.bucket`                   | string                                                       | none          | yes                                   | Remote bucket name; must be non-empty.                        |
| `services.r2-sync.mounts.<name>.remotePrefix`             | string                                                       | `""`          | yes                                   | Remote subpath inside the bucket (mount/sync root).           |
| `services.r2-sync.mounts.<name>.mountPoint`               | path                                                         | none          | yes                                   | Local mount location for `rclone mount`.                      |
| `services.r2-sync.mounts.<name>.localPath`                | `null` or path                                               | `null`        | no                                    | Local bisync side; falls back to `mountPoint`.                |
| `services.r2-sync.mounts.<name>.syncInterval`             | string                                                       | `"5m"`        | no                                    | `OnUnitActiveSec` value for bisync timer.                     |
| `services.r2-sync.mounts.<name>.trashRetention`           | integer                                                      | `30`          | no                                    | Policy hint only; not currently enforced in unit logic.       |
| `services.r2-sync.mounts.<name>.bisync.maxDelete`         | integer                                                      | `100000`      | no                                    | Passed to `rclone bisync --max-delete`.                       |
| `services.r2-sync.mounts.<name>.bisync.checkFilename`     | string                                                       | `".r2-check"` | no                                    | Used for `--check-access` safety.                             |
| `services.r2-sync.mounts.<name>.bisync.initialResyncMode` | enum `path1`, `path2`, `newer`, `older`, `larger`, `smaller` | `"path1"`     | no                                    | Used on first run to seed bisync state.                       |
| `services.r2-sync.mounts.<name>.vfsCache.mode`            | enum `off`, `minimal`, `writes`, `full`                      | `"full"`      | no                                    | Passed to `--vfs-cache-mode`.                                 |
| `services.r2-sync.mounts.<name>.vfsCache.maxSize`         | string                                                       | `"10G"`       | no                                    | Passed to `--vfs-cache-max-size`.                             |
| `services.r2-sync.mounts.<name>.vfsCache.maxAge`          | string                                                       | `"24h"`       | no                                    | Passed to `--vfs-cache-max-age`.                              |

## Mount vs Bisync (How to Use the Two Paths)

Each `mounts.<name>` definition generates two distinct local paths with
different semantics:

- `mountPoint`: a live `rclone mount` view of the remote R2 path.
  - This is not a “synced folder”. It is a remote filesystem view.
  - It uses a VFS cache under `/var/lib/r2-sync-<name>/cache` and may write
    cached/staged data to disk depending on `vfsCache.mode`.
- `localPath`: the local directory used by `rclone bisync` for two-way sync.
  - This is the “Dropbox folder” style local mirror you should edit.
  - Changes are reconciled on the `r2-bisync-<name>` timer.

Typical usage patterns:

- Dropbox-style (recommended): edit `localPath` only; use `mountPoint` only for
  occasional remote inspection/debugging.
- Drive “streaming” style: rely on `mountPoint` (still uses caching) and accept
  online-only behavior.

## Failure semantics

When `enable = true`, evaluation fails if any assertion below is violated:

- `services.r2-sync.credentialsFile must be set when services.r2-sync.enable = true`
- `services.r2-sync.accountId or services.r2-sync.accountIdFile must be set when services.r2-sync.enable = true`
- `services.r2-sync.mounts must define at least one mount when services.r2-sync.enable = true`
- `services.r2-sync.mounts.<name>.bucket must be a non-empty string`
- `services.r2-sync.mounts.<name>.remotePrefix must be non-empty (required for bisync trash backup-dir outside sync root)`

## Trash and safety behavior

- Bisync uses `--check-access` with a per-mount check file (default:
  `.r2-check`). The module ensures the file exists locally and creates it on
  the remote only if missing (it does not update the file once present, since
  changing the check file forces a manual `--resync` recovery).
- Bisync uses backup dirs for soft-delete style recovery:
  - local backup dir: sibling of `localPath`, under `<dirOf(localPath)>/.trash/<name>`
  - remote backup dir: at the bucket root, under `.trash/<remotePrefix>`
  - both are intentionally outside the sync roots to satisfy rclone bisync
    non-overlap requirements.
- Bisync uses a persistent `--workdir` under `/var/lib/r2-sync-<name>/bisync`.
  On first run (no prior state), it automatically runs `--resync` with
  `initialResyncMode` (default: `path1`).
- If prior listing cache exists but no longer matches the current local/remote
  basename pair (for example, path case changes), the wrapper retries once with
  `--resync --resync-mode <initialResyncMode>` automatically.

## Generated runtime artifacts

For each mount name (example: `documents`):

- systemd service: `r2-mount-documents.service`
- systemd service: `r2-bisync-documents.service`
- systemd timer: `r2-bisync-documents.timer`

## Minimal snippet

```nix
{
  services.r2-sync = {
    enable = true;
    credentialsFile = "/run/secrets/r2/credentials.env";
    accountIdFile = "/run/secrets/r2/account-id";

    mounts.documents = {
      bucket = "files";
      remotePrefix = "documents";
      mountPoint = "/mnt/r2/documents";
    };
  };
}
```

## Expanded snippet

```nix
{
  services.r2-sync = {
    enable = true;
    credentialsFile = "/run/secrets/r2/credentials.env";
    accountIdFile = "/run/secrets/r2/account-id";

    mounts.workspace = {
      bucket = "files";
      remotePrefix = "workspace";
      mountPoint = "/mnt/r2/workspace";
      localPath = "/data/r2/workspace";
      syncInterval = "10m";
      trashRetention = 30;
      vfsCache = {
        mode = "full";
        maxSize = "20G";
        maxAge = "48h";
      };
    };
  };
}
```
