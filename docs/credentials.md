# Credentials

Do not commit secrets.

Option reference: `docs/reference/index.md` and `docs/reference/programs-r2-cloud-credentials.md`.

Standardized secrets source (system-wide):

- `secrets/r2.yaml` (SOPS-managed, YAML only)

Runtime extraction paths (system):

- `/run/secrets/r2/account-id`
- `/run/secrets/r2/access-key-id`
- `/run/secrets/r2/secret-access-key`
- `/run/secrets/r2/restic-password`
- `/run/secrets/r2/credentials.env` (rendered via `sops.templates`)

`/run/secrets/r2/credentials.env` is the env file expected by system services
(`services.r2-sync`, `services.r2-restic`, `programs.git-annex-r2`).

Home Manager credential assembly is still supported for user-scoped CLI
defaults:

- `programs.r2-cloud.credentials.manage = true` writes
  `~/.config/cloudflare/r2/env` from `accessKeyIdFile` and
  `secretAccessKeyFile`, then applies `0400` permissions.
