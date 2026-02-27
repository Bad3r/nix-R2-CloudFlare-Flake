# Plan Status

Last updated: **2026-02-27**

## Current State

Phase completion:

- Phase 1-7: complete.
- Phase 8: complete (consumer `~/nixos` integration + real-host runtime validation + docs feedback loop).

Known-good production inventory (as validated on `system76`):

- Worker host: `https://files.unsigned.sh`
- Worker services: `r2-explorer` (production), `r2-explorer-preview` (preview)
- R2 buckets:
- `nix-r2-cf-r2e-files-prod` (host runtime + Worker production binding)
- `nix-r2-cf-r2e-files-preview` (Worker preview binding)
- `nix-r2-cf-backups-prod` (restic repository)
- Host/user:
- host: `system76`
- Home Manager user: `vx`
- r2-sync mount:
- mount name: `workspace`
- local path: `/data/r2/workspace`
- mount point: `/data/r2/mount/workspace`
- remote prefix: `workspace`
- Runtime secret files (system-scoped):
- `/run/secrets/r2/account-id`
- `/run/secrets/r2/credentials.env`
- `/run/secrets/r2/restic-password`
- `/run/secrets/r2/explorer.env` (Worker OAuth client credentials for `r2 share worker ...`)

Acceptance checks that passed on `system76`:

- `r2-mount-workspace.service` active and mount is host-visible:
  `mountpoint -q /data/r2/mount/workspace`
- timers active:
- `r2-bisync-workspace.timer`
- `r2-restic-backup.timer`
- Live remote connectivity (runtime secrets only):
- `rclone lsf :s3:nix-r2-cf-r2e-files-prod ...` succeeds
- `restic ... snapshots` succeeds against `nix-r2-cf-backups-prod`
- Sharing UX:
- `r2 share nix-r2-cf-r2e-files-prod workspace/demo.txt 1h` returns a URL
- Worker token share works:
  `r2 share worker create files workspace/demo.txt 10m --max-downloads 1`
  returns a URL under `files.unsigned.sh/share/<token>` and enforces max-downloads
- Direct IdP auth remains enforced:
  `curl -I https://files.unsigned.sh/api/v2/list` returns `401` with `token_missing`

## What's Next

Consumer repo (`~/nixos`) completion items:

- Commit + push the Phase 8 wiring (including the `secrets` submodule pointer and `flake.lock` updates) so the system state is reproducible from Git.
- Extend `services.r2-sync.mounts.*` and `services.r2-restic.paths` for any additional production paths beyond `/data/r2/workspace`.

Operations:

- Rotate OAuth client credentials periodically using `docs/operators/key-rotation.md`.
- Keep direct IdP bearer auth on `files.unsigned.sh`:
- `/api/v2/*` validated in-worker against issuer/audience/JWKS.
- `/share/*` remains public for token links.
- Keep preview as an independent direct-IdP API surface:
  - `preview.files.unsigned.sh/api/v2/*` uses preview issuer/audience settings.
  - `preview.files.unsigned.sh/share/*` remains public token route.

Optional upstream follow-ups:

- Cut a release version after consumer repo changes are merged, so `~/nixos` can pin a stable tag.
- Add a small CI/runbook lint rule to flag stale Access/HMAC references in operational docs.
