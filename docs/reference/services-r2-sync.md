# `services.r2-sync` Reference

Provides rclone mount + bisync services/timers for one or more R2 buckets.

Activation condition: `services.r2-sync.enable = true`.

Credentials are expected in `/run/secrets/r2/credentials.env` (rendered from
`secrets/r2.yaml` via sops templates).

## Options

| Option                                            | Type                  | Default | Required when enabled                 | Notes                                                         |
| ------------------------------------------------- | --------------------- | ------- | ------------------------------------- | ------------------------------------------------------------- | -------- | --- | ----------------------------- |
| `services.r2-sync.enable`                         | boolean               | `false` | no                                    | Enables service and timer generation.                         |
| `services.r2-sync.credentialsFile`                | `null` or path        | `null`  | yes                                   | Environment file loaded by systemd units.                     |
| `services.r2-sync.accountId`                      | string                | `""`    | yes (if file unset)                   | Used to build `https://<accountId>.r2.cloudflarestorage.com`. |
| `services.r2-sync.accountIdFile`                  | `null` or path        | `null`  | yes (if literal unset)                | File-based account ID source.                                 |
| `services.r2-sync.mounts`                         | attrset of submodules | `{}`    | yes (must contain at least one mount) | One mount profile per attr key.                               |
| `services.r2-sync.mounts.<name>.bucket`           | string                | none    | yes                                   | Remote bucket name; must be non-empty.                        |
| `services.r2-sync.mounts.<name>.mountPoint`       | path                  | none    | yes                                   | Local mount location for `rclone mount`.                      |
| `services.r2-sync.mounts.<name>.localPath`        | `null` or path        | `null`  | no                                    | Local bisync side; falls back to `mountPoint`.                |
| `services.r2-sync.mounts.<name>.syncInterval`     | string                | `"5m"`  | no                                    | `OnUnitActiveSec` value for bisync timer.                     |
| `services.r2-sync.mounts.<name>.trashRetention`   | integer               | `30`    | no                                    | Policy hint only; not currently enforced in unit logic.       |
| `services.r2-sync.mounts.<name>.vfsCache.mode`    | enum `off             | minimal | writes                                | full`                                                         | `"full"` | no  | Passed to `--vfs-cache-mode`. |
| `services.r2-sync.mounts.<name>.vfsCache.maxSize` | string                | `"10G"` | no                                    | Passed to `--vfs-cache-max-size`.                             |
| `services.r2-sync.mounts.<name>.vfsCache.maxAge`  | string                | `"24h"` | no                                    | Passed to `--vfs-cache-max-age`.                              |

## Failure semantics

When `enable = true`, evaluation fails if any assertion below is violated:

- `services.r2-sync.credentialsFile must be set when services.r2-sync.enable = true`
- `services.r2-sync.accountId or services.r2-sync.accountIdFile must be set when services.r2-sync.enable = true`
- `services.r2-sync.mounts must define at least one mount when services.r2-sync.enable = true`
- `services.r2-sync.mounts.<name>.bucket must be a non-empty string`

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
      bucket = "documents";
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
      mountPoint = "/mnt/r2/workspace";
      localPath = "/srv/r2/workspace";
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
