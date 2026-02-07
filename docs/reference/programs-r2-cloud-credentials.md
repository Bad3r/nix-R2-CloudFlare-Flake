# `programs.r2-cloud.credentials` Reference

Home Manager credential file assembly for the `r2` CLI and related tooling.

Activation condition: `programs.r2-cloud.credentials.manage = true`.

## Options

| Option | Type | Default | Required when enabled | Notes |
| --- | --- | --- | --- | --- |
| `programs.r2-cloud.credentials.manage` | boolean | `false` | no | Enables activation step that writes env file with `0400` mode. |
| `programs.r2-cloud.credentials.accountId` | string | `""` | yes unless inherited from `programs.r2-cloud.accountId` | Effective accountId comes from this option first, then top-level `programs.r2-cloud.accountId`. |
| `programs.r2-cloud.credentials.accessKeyIdFile` | `null` or path | `null` | yes | Must point to readable file containing AWS access key id. |
| `programs.r2-cloud.credentials.secretAccessKeyFile` | `null` or path | `null` | yes | Must point to readable file containing AWS secret key. |
| `programs.r2-cloud.credentials.outputFile` | path | `${config.xdg.configHome}/cloudflare/r2/env` | no | Generated env file location. |

## Failure semantics

When `manage = true`, evaluation fails if any assertion below is violated:

- `programs.r2-cloud.credentials.accountId (or programs.r2-cloud.accountId) must be set when programs.r2-cloud.credentials.manage = true`
- `programs.r2-cloud.credentials.accessKeyIdFile must be set when programs.r2-cloud.credentials.manage = true`
- `programs.r2-cloud.credentials.secretAccessKeyFile must be set when programs.r2-cloud.credentials.manage = true`
- `programs.r2-cloud.credentials.outputFile must match programs.r2-cloud.credentialsFile when both credential management and programs.r2-cloud.enable are enabled`

Activation-time failures are explicit and fatal if source files are missing/unreadable/empty.

## Generated runtime artifacts

Activation writes `outputFile` containing:

- `R2_ACCOUNT_ID=<value>`
- `AWS_ACCESS_KEY_ID=<value>`
- `AWS_SECRET_ACCESS_KEY=<value>`

Permission mode is forced to `0400`.

## Minimal snippet

```nix
{
  programs.r2-cloud.accountId = "abc123def456";

  programs.r2-cloud.credentials = {
    manage = true;
    accessKeyIdFile = "/run/secrets/r2-access-key-id";
    secretAccessKeyFile = "/run/secrets/r2-secret-access-key";
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
  };

  programs.r2-cloud.credentials = {
    manage = true;
    outputFile = "/home/alice/.config/cloudflare/r2/env";
    accessKeyIdFile = "/run/secrets/r2-access-key-id";
    secretAccessKeyFile = "/run/secrets/r2-secret-access-key";
  };
}
```
