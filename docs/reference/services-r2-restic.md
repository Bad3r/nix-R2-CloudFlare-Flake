# `services.r2-restic` Reference

Provides scheduled restic backups to an R2 bucket.

Activation condition: `services.r2-restic.enable = true`.

Credentials are expected in `/run/secrets/r2/credentials.env` (rendered from
`secrets/r2.yaml` via sops templates).

## Options

| Option                                 | Type            | Default   | Required when enabled  | Notes                                                                                                                   |
| -------------------------------------- | --------------- | --------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `services.r2-restic.enable`            | boolean         | `false`   | no                     | Enables backup service + timer.                                                                                         |
| `services.r2-restic.credentialsFile`   | `null` or path  | `null`    | yes                    | Environment file for AWS/R2 auth values.                                                                                |
| `services.r2-restic.accountId`         | string          | `""`      | yes (if file unset)    | Used in R2 endpoint URL.                                                                                                |
| `services.r2-restic.accountIdFile`     | `null` or path  | `null`    | yes (if literal unset) | File-based account ID source.                                                                                           |
| `services.r2-restic.passwordFile`      | `null` or path  | `null`    | yes                    | Exported as `RESTIC_PASSWORD_FILE`.                                                                                     |
| `services.r2-restic.bucket`            | string          | `""`      | yes                    | Bucket name used in `RESTIC_REPOSITORY`.                                                                                |
| `services.r2-restic.initialize`        | boolean         | `true`    | no                     | Run `restic init` before the backup when the repository probe fails, so the first backup into an empty bucket succeeds. |
| `services.r2-restic.paths`             | list of paths   | `[]`      | yes (non-empty)        | Backup input paths.                                                                                                     |
| `services.r2-restic.exclude`           | list of strings | `[]`      | no                     | Converted to `--exclude` flags.                                                                                         |
| `services.r2-restic.schedule`          | string          | `"daily"` | no                     | `systemd` `OnCalendar` expression.                                                                                      |
| `services.r2-restic.retention.daily`   | integer         | `7`       | no                     | Must be `>= 0`.                                                                                                         |
| `services.r2-restic.retention.weekly`  | integer         | `4`       | no                     | Must be `>= 0`.                                                                                                         |
| `services.r2-restic.retention.monthly` | integer         | `12`      | no                     | Must be `>= 0`.                                                                                                         |
| `services.r2-restic.retention.yearly`  | integer         | `3`       | no                     | Must be `>= 0`.                                                                                                         |

## Failure semantics

When `enable = true`, evaluation fails if any assertion below is violated:

- `services.r2-restic.credentialsFile must be set when services.r2-restic.enable = true`
- `services.r2-restic.accountId or services.r2-restic.accountIdFile must be set when services.r2-restic.enable = true`
- `services.r2-restic.passwordFile must be set when services.r2-restic.enable = true`
- `services.r2-restic.bucket must be set when services.r2-restic.enable = true`
- `services.r2-restic.bucket must be a valid R2 bucket name (3-63 lowercase letters, digits, or hyphens; must start and end with a letter or digit): got '<bucket>'`
- `services.r2-restic.paths must contain at least one path when services.r2-restic.enable = true`
- `services.r2-restic.retention values must be >= 0`

When `initialize = true` (the default), an `ExecStartPre` probe checks the
repository and runs `restic init` when the probe fails. The probe script runs
under `set -euo pipefail`, so a failed `restic init` (for example, credentials
that cannot reach an already-initialized repository) fails the unit before
`restic backup` starts.

`restic backup`'s own exit code is handled explicitly in the backup script,
not left to `set -e`:

- Exit `0`: backup succeeded; continue to `unlock`/`forget --prune`.
- Exit `3`: some source files could not be read, but restic still created a
  snapshot. The script prints a warning to stderr naming the condition, still
  runs `restic unlock` and `restic forget --prune`, then exits `3` so
  `systemctl status r2-restic-backup` reports failure instead of hiding the
  partial read.
- Any other exit code: fatal. The script exits immediately with that status
  and does not run `unlock` or `forget --prune`.

`restic unlock` always runs immediately before `forget --prune` (matching
`services.restic.backups.*`'s `pruneCmd` in nixpkgs), clearing locks left by a
crashed or killed prior run before pruning.

## Generated runtime artifacts

- `r2-restic-backup.service` (`Type=oneshot`)
- `r2-restic-backup.timer` (`OnCalendar = services.r2-restic.schedule`)
- `CacheDirectory = "r2-restic-backup"` (mode `0700`), exported to the init
  and backup scripts as `RESTIC_CACHE_DIR=/var/cache/r2-restic-backup`.
  systemd creates and chowns this directory to the unit's effective
  `User`/`Group`, including when a consuming host overrides them.

## Minimal snippet

```nix
{
  services.r2-restic = {
    enable = true;
    credentialsFile = "/run/secrets/r2/credentials.env";
    accountIdFile = "/run/secrets/r2/account-id";
    passwordFile = "/run/secrets/r2/restic-password";
    bucket = "backups";
    paths = [ "/data/r2/workspace" ];
  };
}
```

## Expanded snippet

```nix
{
  services.r2-restic = {
    enable = true;
    credentialsFile = "/run/secrets/r2/credentials.env";
    accountIdFile = "/run/secrets/r2/account-id";
    passwordFile = "/run/secrets/r2/restic-password";
    bucket = "backups";
    paths = [
      "/data/r2/workspace"
      "/etc/nixos"
    ];
    exclude = [
      "*.tmp"
      ".cache"
    ];
    schedule = "daily";
    retention = {
      daily = 7;
      weekly = 4;
      monthly = 12;
      yearly = 3;
    };
  };
}
```
