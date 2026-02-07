# Credentials

Do not commit secrets.

Option reference: `docs/reference/index.md` and `docs/reference/programs-r2-cloud-credentials.md`.

Default runtime credentials file:

- `~/.config/cloudflare/r2/env`

When using `programs.r2-cloud.credentials.manage = true`, the Home Manager module
assembles this file from `accessKeyIdFile` and `secretAccessKeyFile`, then applies
`0400` permissions.
