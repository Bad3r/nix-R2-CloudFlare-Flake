# `programs.r2-cloud` Reference

Home Manager wrapper surface for the `r2` CLI and optional tooling.

Activation condition: `programs.r2-cloud.enable = true`.

## Options

| Option                                 | Type           | Default                                       | Required when enabled                | Notes                                                                                          |
| -------------------------------------- | -------------- | --------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `programs.r2-cloud.enable`             | boolean        | `false`                                       | no                                   | Installs wrapper `r2` command into `home.packages`.                                            |
| `programs.r2-cloud.accountId`          | string         | `""`                                          | yes                                  | Exported to wrapper as `R2_DEFAULT_ACCOUNT_ID`.                                                |
| `programs.r2-cloud.accountIdFile`      | path or `null` | `null`                                        | yes (if `accountId` empty)           | File-based account ID source; used when literal is unset.                                      |
| `programs.r2-cloud.credentialsFile`    | path           | `${config.xdg.configHome}/cloudflare/r2/env`  | yes                                  | Exported as `R2_CREDENTIALS_FILE`.                                                             |
| `programs.r2-cloud.explorerEnvFile`    | path or `null` | `null`                                        | no                                   | Optional extra env file sourced by wrapper for Worker share vars.                              |
| `programs.r2-cloud.enableRcloneRemote` | boolean        | `true`                                        | no                                   | Drives managed rclone config behavior.                                                         |
| `programs.r2-cloud.rcloneRemoteName`   | string         | `"r2"`                                        | yes when `enableRcloneRemote = true` | Used by rclone config generation + wrappers.                                                   |
| `programs.r2-cloud.rcloneConfigPath`   | path           | `${config.xdg.configHome}/rclone/rclone.conf` | no                                   | Exported as `R2_RCLONE_CONFIG`.                                                                |
| `programs.r2-cloud.installTools`       | boolean        | `true`                                        | no                                   | Installs runtime dependencies (`rclone`, `restic`, optional `git-annex`, optional `wrangler`). |

## Failure semantics

When `enable = true`, evaluation fails if any assertion below is violated:

- `programs.r2-cloud.accountId or programs.r2-cloud.accountIdFile must be set when programs.r2-cloud.enable = true`
- `programs.r2-cloud.credentialsFile must be set when programs.r2-cloud.enable = true`
- `programs.r2-cloud.rcloneRemoteName must be a non-empty string when programs.r2-cloud.enableRcloneRemote = true`

## Generated runtime artifacts

- wrapper command: `r2`
- delegated CLI derivation: versioned as `r2-0.1.0+git.<rev>` (fallback `r2-0.1.0+src.<hash>`) so `nh`/`nvd` can detect source/revision changes while executable stays `r2`
- wrapper exports:
  - `R2_CREDENTIALS_FILE`
  - variables from `programs.r2-cloud.explorerEnvFile` (if configured and readable)
  - `R2_RCLONE_CONFIG`
  - `R2_DEFAULT_ACCOUNT_ID`
  - `RCLONE_CONFIG_<REMOTE>_ENDPOINT` when endpoint-less mode is used

## Minimal snippet

```nix
{
  programs.r2-cloud = {
    enable = true;
    accountIdFile = "/run/secrets/r2/account-id";
    explorerEnvFile = "/run/secrets/r2/explorer.env";
  };
}
```

## Expanded snippet

```nix
{
  programs.r2-cloud = {
    enable = true;
    accountIdFile = "/run/secrets/r2/account-id";
    credentialsFile = "/home/alice/.config/cloudflare/r2/env";
    explorerEnvFile = "/run/secrets/r2/explorer.env";
    enableRcloneRemote = true;
    rcloneRemoteName = "r2";
    rcloneConfigPath = "/home/alice/.config/rclone/rclone.conf";
    installTools = true;
  };
}
```
