# `programs.git-annex-r2` Reference

Provides a git-annex helper for configuring R2 as a special remote.

Activation condition: `programs.git-annex-r2.enable = true`.

## Options

| Option                                   | Type             | Default | Required when enabled | Notes                                                        |
| ---------------------------------------- | ---------------- | ------- | --------------------- | ------------------------------------------------------------ |
| `programs.git-annex-r2.enable`           | boolean          | `false` | no                    | Installs git-annex packages and `git-annex-r2-init`.         |
| `programs.git-annex-r2.credentialsFile`  | `null` or path   | `null`  | yes                   | Used by helper to source auth env.                           |
| `programs.git-annex-r2.rcloneRemoteName` | string           | `"r2"`  | yes                   | Default `rcloneremotename` passed to `git annex initremote`. |
| `programs.git-annex-r2.defaultBucket`    | `null` or string | `null`  | no                    | Hint used by helper when bucket arg is omitted.              |
| `programs.git-annex-r2.defaultPrefix`    | `null` or string | `null`  | no                    | Default `rcloneprefix` when prefix arg is omitted.           |

## Failure semantics

When `enable = true`, evaluation fails if any assertion below is violated:

- `programs.git-annex-r2.credentialsFile must be set when programs.git-annex-r2.enable = true`
- `programs.git-annex-r2.rcloneRemoteName must be a non-empty string when programs.git-annex-r2.enable = true`
- `programs.git-annex-r2.defaultBucket must be null or a non-empty string when programs.git-annex-r2.enable = true`
- `programs.git-annex-r2.defaultPrefix must be null or a non-empty string when programs.git-annex-r2.enable = true`

Runtime helper failures are explicit and fatal if credentials are missing or malformed.

## Generated runtime artifacts

Packages added to `environment.systemPackages`:

- `git-annex`
- `rclone`
- `git-annex-r2-init`

## Minimal snippet

```nix
{
  programs.git-annex-r2 = {
    enable = true;
    credentialsFile = "/run/secrets/r2-credentials";
  };
}
```

## Expanded snippet

```nix
{
  programs.git-annex-r2 = {
    enable = true;
    credentialsFile = "/run/secrets/r2-credentials";
    rcloneRemoteName = "r2";
    defaultBucket = "project-files";
    defaultPrefix = "annex/project-files";
  };
}
```
