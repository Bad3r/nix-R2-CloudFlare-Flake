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
- `programs.r2-cloud.accountId or programs.r2-cloud.accountIdFile must be set when programs.r2-cloud.enableRcloneRemote = true`

## Generated config shape

The generated file contains:

```ini
[<rcloneRemoteName>]
type = s3
provider = Cloudflare
env_auth = true
endpoint = https://<accountId>.r2.cloudflarestorage.com
```

If `accountId` is not set and `accountIdFile` is used, the generated config
omits the `endpoint` line and relies on `RCLONE_CONFIG_<REMOTE>_ENDPOINT` at
runtime.

## Endpoint-less mode

When `accountId` is resolved at runtime (file/env), the managed config omits
`endpoint`. In that case:

- `r2` wrapper exports `RCLONE_CONFIG_<REMOTE>_ENDPOINT` automatically.
- bare `rclone` requires manual export of `RCLONE_CONFIG_<REMOTE>_ENDPOINT`.
- `<REMOTE>` must be env-var-safe (`[A-Za-z0-9_]+`) for endpoint export.

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
