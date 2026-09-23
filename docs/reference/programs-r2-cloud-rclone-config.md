# `programs.r2-cloud` Managed rclone Config Reference

`modules/home-manager/rclone-config.nix` does not define independent options.
It derives behavior from `programs.r2-cloud` and writes an `xdg.configFile` entry.

Activation condition:

- `programs.r2-cloud.enable = true`
- `programs.r2-cloud.enableRcloneRemote = true`

## Driving options

| Option                                 | Type           | Default                                       | Required when remote is enabled         | Notes                                      |
| -------------------------------------- | -------------- | --------------------------------------------- | --------------------------------------- | ------------------------------------------ |
| `programs.r2-cloud.enableRcloneRemote` | boolean        | `true`                                        | yes (must remain true to manage config) | Controls whether config is generated.      |
| `programs.r2-cloud.rcloneConfigPath`   | path           | `${config.xdg.configHome}/rclone/rclone.conf` | yes                                     | Must stay within `config.xdg.configHome`.  |
| `programs.r2-cloud.rcloneRemoteName`   | string         | `"r2"`                                        | yes                                     | Remote section header in generated config. |
| `programs.r2-cloud.accountId`          | string         | `""`                                          | yes (if file unset)                     | Used to render endpoint URL.               |
| `programs.r2-cloud.accountIdFile`      | path or `null` | `null`                                        | yes (if literal unset)                  | File-based account ID source.              |

## Failure semantics

When managed remote generation is active, evaluation fails if any assertion below is violated:

- `programs.r2-cloud.rcloneConfigPath must be within config.xdg.configHome when programs.r2-cloud.enableRcloneRemote = true`
- `programs.r2-cloud.rcloneConfigPath must not equal config.xdg.configHome when programs.r2-cloud.enableRcloneRemote = true`
- `programs.r2-cloud.rcloneRemoteName must be a non-empty string when programs.r2-cloud.enableRcloneRemote = true`
- `programs.r2-cloud.enableRcloneRemote and programs.rclone.enable must not both manage the same rclone.conf; disable programs.r2-cloud.enableRcloneRemote and declare the R2 remote under programs.rclone.remotes, or disable programs.rclone`

`programs.r2-cloud.accountId`/`accountIdFile` are enforced by
`programs.r2-cloud`'s own assertion (see `programs-r2-cloud.md`) once
`programs.r2-cloud.enable = true`; this module does not re-check them.

## Generated config shape

The generated file contains:

```ini
[<rcloneRemoteName>]
type = s3
provider = Cloudflare
env_auth = true
no_check_bucket = true
endpoint = https://<accountId>.r2.cloudflarestorage.com
```

`no_check_bucket = true` is always emitted, with no option to disable it. A
Cloudflare R2 API token scoped to "Object Read & Write" (rather than full
Admin) cannot perform the bucket-existence check rclone otherwise runs before
the first upload; R2 buckets in this project are created out of band, so the
check is skipped unconditionally.

If `accountId` is not set and `accountIdFile` is used, the generated config
omits the `endpoint` line and relies on `RCLONE_CONFIG_<REMOTE>_ENDPOINT` at
runtime.

## Incompatibility with `programs.rclone`

Home Manager's own `programs.rclone` module, when `programs.rclone.enable =
true`, manages `${config.xdg.configHome}/rclone/rclone.conf` through a
systemd user service that overwrites the file independently of
`home-manager switch` activation timing. This module manages the same
default path through `xdg.configFile`, applied during activation's
`linkGeneration` step. Enabling both against the same path is unsupported:
whichever mechanism runs later silently discards the other's remotes, with no
merge. The assertion above catches the common case (both at their default
paths); it does not catch a `rcloneConfigPath` deliberately pointed back at
the same file some other way.

To use both `programs.rclone` and an R2 remote, either:

- Disable `programs.r2-cloud.enableRcloneRemote` and declare the equivalent
  remote directly under `programs.rclone.remotes`, using the same keys this
  module generates:

  ```nix
  programs.rclone.remotes.r2.config = {
    type = "s3";
    provider = "Cloudflare";
    env_auth = true;
    no_check_bucket = true;
    endpoint = "https://<accountId>.r2.cloudflarestorage.com";
  };
  ```

- Or disable `programs.rclone`.

## Endpoint-less mode

When `accountId` is resolved at runtime (file/env), the managed config omits
`endpoint`. In that case:

- `r2` wrapper exports `RCLONE_CONFIG_<REMOTE>_ENDPOINT` automatically.
- bare `rclone` requires manual export of `RCLONE_CONFIG_<REMOTE>_ENDPOINT`.
- `<REMOTE>` must be env-var-safe (`[A-Za-z0-9_]+`) for endpoint export. An
  assertion in `programs.r2-cloud` rejects other names at evaluation time when
  `accountId` is empty (see `programs-r2-cloud.md`, "Failure semantics").

## Minimal snippet

```nix
{
  programs.r2-cloud = {
    enable = true;
    accountIdFile = "/run/secrets/r2/account-id";
    enableRcloneRemote = true;
  };
}
```

## Expanded snippet

```nix
{
  programs.r2-cloud = {
    enable = true;
    accountIdFile = "/run/secrets/r2/account-id";
    enableRcloneRemote = true;
    rcloneRemoteName = "r2";
    rcloneConfigPath = "/home/alice/.config/rclone/rclone.conf";
  };
}
```
