# `programs.r2-cloud` Reference

Home Manager wrapper surface for the `r2` CLI and optional tooling.

Activation condition: `programs.r2-cloud.enable = true`.

## Options

| Option                                 | Type           | Default                                       | Required when enabled                | Notes                                                                                                           |
| -------------------------------------- | -------------- | --------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `programs.r2-cloud.enable`             | boolean        | `false`                                       | no                                   | Installs wrapper `r2` command into `home.packages`.                                                             |
| `programs.r2-cloud.package`            | package        | the flake's `r2` CLI (`packages/r2-cli.nix`)  | no                                   | Override the `r2` wrapper package installed into `home.packages`.                                               |
| `programs.r2-cloud.accountId`          | string         | `""`                                          | yes                                  | Exported to wrapper as `R2_DEFAULT_ACCOUNT_ID`.                                                                 |
| `programs.r2-cloud.accountIdFile`      | path or `null` | `null`                                        | yes (if `accountId` empty)           | File-based account ID source; used when literal is unset.                                                       |
| `programs.r2-cloud.credentialsFile`    | path           | `${config.xdg.configHome}/cloudflare/r2/env`  | no                                   | Exported as `R2_CREDENTIALS_FILE`. Parsed as `KEY=VALUE` data (see "Env file format").                          |
| `programs.r2-cloud.explorerEnvFile`    | path or `null` | `null`                                        | no                                   | Optional extra env file sourced by wrapper for Worker share vars.                                               |
| `programs.r2-cloud.enableRcloneRemote` | boolean        | `true`                                        | no                                   | Drives managed rclone config behavior.                                                                          |
| `programs.r2-cloud.rcloneRemoteName`   | string         | `"r2"`                                        | yes when `enableRcloneRemote = true` | Used by rclone config generation + wrappers.                                                                    |
| `programs.r2-cloud.rcloneConfigPath`   | path           | `${config.xdg.configHome}/rclone/rclone.conf` | no                                   | Exported as `R2_RCLONE_CONFIG`.                                                                                 |
| `programs.r2-cloud.installTools`       | boolean        | `true`                                        | no                                   | Installs runtime dependencies (`rclone`, `restic`, `wrangler`, and `git-annex` when packaged for the platform). |

## Failure semantics

When `enable = true`, evaluation fails if any assertion below is violated:

- `programs.r2-cloud.accountId or programs.r2-cloud.accountIdFile must be set when programs.r2-cloud.enable = true`
- `programs.r2-cloud.rcloneRemoteName must be a non-empty string when programs.r2-cloud.enableRcloneRemote = true`
- `programs.r2-cloud.rcloneRemoteName must be env-var-safe ([A-Za-z0-9_]+) when programs.r2-cloud.enableRcloneRemote = true and programs.r2-cloud.accountId is empty, because it is exported as RCLONE_CONFIG_<REMOTE>_ENDPOINT`

## Generated runtime artifacts

- wrapper command: `r2`
- delegated CLI derivation: versioned as `r2-0.1.0+git.<rev>` (fallback `r2-0.1.0+src.<hash>`) so `nh`/`nvd` can detect source/revision changes while executable stays `r2`
- `r2 version` / `r2 --version` prints that same version string (matches the derivation's `passthru.version`); the Home Manager wrapper forwards `version`/`--version` straight to the inner CLI without resolving an account ID or reading any file
- wrapper exports:
  - `R2_CREDENTIALS_FILE`
  - variables from `programs.r2-cloud.explorerEnvFile` (if configured and readable)
  - `R2_RCLONE_CONFIG`
  - `R2_DEFAULT_ACCOUNT_ID`: the Home-Manager-resolved account ID. An explicit `R2_ACCOUNT_ID` from the environment or from `credentialsFile` takes precedence over this default when both are set; the CLI prints one warning to stderr when both are non-empty and differ
  - `RCLONE_CONFIG_<REMOTE>_ENDPOINT` when endpoint-less mode is used

## Env file format

`credentialsFile` and `explorerEnvFile` are parsed as `KEY=VALUE` data, not
executed as shell (a malformed line cannot run as a command):

- Blank lines and comment lines (`#`, optionally indented) are skipped.
- An optional leading `export ` is allowed before `KEY`.
- `KEY` must match `[A-Za-z_][A-Za-z0-9_]*`.
- A trailing CR is stripped from each line.
- An unquoted `VALUE` has surrounding whitespace trimmed.
- Text after an unquoted `VALUE`, including ` # note`, is part of the value;
  a `#` starts a comment only as the first non-blank character of a line.
- Backslashes are never escapes, in quoted or unquoted values: `KEY=a\ b`
  keeps the backslash, and `KEY=value\ ` keeps it too while the trim above
  drops the space. Quote a value that must end in a space: `KEY="value "`.
- A `VALUE` wrapped in matching single or double quotes has the quotes
  removed; the content is otherwise literal (no expansion, no escapes). The
  quotes must be the first and last characters of the trimmed value, so
  `KEY="value" # note` keeps them and exports `"value" # note` (`source`
  gives `value`), and `KEY="a" "b"` strips only the outer pair and exports
  `a" "b` (`source` runs `b` as a command and leaves `KEY` unset).
- Any other line fails with `Error: <file>: line <N>: expected KEY=VALUE` and
  stops loading the file, without printing the line content.

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
