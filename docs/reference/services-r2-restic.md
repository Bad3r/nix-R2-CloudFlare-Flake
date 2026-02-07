# `services.r2-restic` Reference

Provides scheduled restic backups to an R2 bucket.

Activation condition: `services.r2-restic.enable = true`.

## Options

| Option                                 | Type            | Default   | Required when enabled | Notes                                    |
| -------------------------------------- | --------------- | --------- | --------------------- | ---------------------------------------- |
| `services.r2-restic.enable`            | boolean         | `false`   | no                    | Enables backup service + timer.          |
| `services.r2-restic.credentialsFile`   | `null` or path  | `null`    | yes                   | Environment file for AWS/R2 auth values. |
| `services.r2-restic.accountId`         | string          | `""`      | yes                   | Used in R2 endpoint URL.                 |
| `services.r2-restic.passwordFile`      | `null` or path  | `null`    | yes                   | Exported as `RESTIC_PASSWORD_FILE`.      |
| `services.r2-restic.bucket`            | string          | `""`      | yes                   | Bucket name used in `RESTIC_REPOSITORY`. |
| `services.r2-restic.paths`             | list of paths   | `[]`      | yes (non-empty)       | Backup input paths.                      |
| `services.r2-restic.exclude`           | list of strings | `[]`      | no                    | Converted to `--exclude` flags.          |
| `services.r2-restic.schedule`          | string          | `"daily"` | no                    | `systemd` `OnCalendar` expression.       |
| `services.r2-restic.retention.daily`   | integer         | `7`       | no                    | Must be `>= 0`.                          |
| `services.r2-restic.retention.weekly`  | integer         | `4`       | no                    | Must be `>= 0`.                          |
| `services.r2-restic.retention.monthly` | integer         | `12`      | no                    | Must be `>= 0`.                          |
| `services.r2-restic.retention.yearly`  | integer         | `3`       | no                    | Must be `>= 0`.                          |

## Failure semantics

When `enable = true`, evaluation fails if any assertion below is violated:

- `services.r2-restic.credentialsFile must be set when services.r2-restic.enable = true`
- `services.r2-restic.accountId must be set when services.r2-restic.enable = true`
- `services.r2-restic.passwordFile must be set when services.r2-restic.enable = true`
- `services.r2-restic.bucket must be set when services.r2-restic.enable = true`
- `services.r2-restic.paths must contain at least one path when services.r2-restic.enable = true`
- `services.r2-restic.retention values must be >= 0`

## Generated runtime artifacts

- `r2-restic-backup.service` (`Type=oneshot`)
- `r2-restic-backup.timer` (`OnCalendar = services.r2-restic.schedule`)

## Minimal snippet

```nix
{
  services.r2-restic = {
    enable = true;
    credentialsFile = "/run/secrets/r2-credentials";
    accountId = "abc123def456";
    passwordFile = "/run/secrets/restic-password";
    bucket = "backups";
    paths = [ "/srv/r2/workspace" ];
  };
}
```

## Expanded snippet

```nix
{
  services.r2-restic = {
    enable = true;
    credentialsFile = "/run/secrets/r2-credentials";
    accountId = "abc123def456";
    passwordFile = "/run/secrets/restic-password";
    bucket = "backups";
    paths = [
      "/srv/r2/workspace"
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
