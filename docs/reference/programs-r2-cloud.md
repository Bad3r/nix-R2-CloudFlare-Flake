# `programs.r2-cloud` Reference

Home Manager wrapper surface for the `r2` CLI and optional tooling.

Activation condition: `programs.r2-cloud.enable = true`.

## Options

| Option | Type | Default | Required when enabled | Notes |
| --- | --- | --- | --- | --- |
| `programs.r2-cloud.enable` | boolean | `false` | no | Installs wrapper `r2` command into `home.packages`. |
| `programs.r2-cloud.accountId` | string | `""` | yes | Exported to wrapper as `R2_DEFAULT_ACCOUNT_ID`. |
| `programs.r2-cloud.credentialsFile` | path | `${config.xdg.configHome}/cloudflare/r2/env` | yes | Exported as `R2_CREDENTIALS_FILE`. |
| `programs.r2-cloud.enableRcloneRemote` | boolean | `true` | no | Drives managed rclone config behavior. |
| `programs.r2-cloud.rcloneRemoteName` | string | `"r2"` | yes when `enableRcloneRemote = true` | Used by rclone config generation + wrappers. |
| `programs.r2-cloud.rcloneConfigPath` | path | `${config.xdg.configHome}/rclone/rclone.conf` | no | Exported as `R2_RCLONE_CONFIG`. |
| `programs.r2-cloud.installTools` | boolean | `true` | no | Installs runtime dependencies (`rclone`, `restic`, optional `git-annex`, optional `wrangler`). |

## Failure semantics

When `enable = true`, evaluation fails if any assertion below is violated:

- `programs.r2-cloud.accountId must be set when programs.r2-cloud.enable = true`
- `programs.r2-cloud.credentialsFile must be set when programs.r2-cloud.enable = true`
- `programs.r2-cloud.rcloneRemoteName must be a non-empty string when programs.r2-cloud.enableRcloneRemote = true`

## Generated runtime artifacts

- wrapper command: `r2`
- wrapper exports:
  - `R2_CREDENTIALS_FILE`
  - `R2_RCLONE_CONFIG`
  - `R2_DEFAULT_ACCOUNT_ID`

## Minimal snippet

```nix
{
  programs.r2-cloud = {
    enable = true;
    accountId = "abc123def456";
  };
}
```

## Expanded snippet

```nix
{
  programs.r2-cloud = {
    enable = true;
    accountId = "abc123def456";
    credentialsFile = "/home/alice/.config/cloudflare/r2/env";
    enableRcloneRemote = true;
    rcloneRemoteName = "r2";
    rcloneConfigPath = "/home/alice/.config/rclone/rclone.conf";
    installTools = true;
  };
}
```
