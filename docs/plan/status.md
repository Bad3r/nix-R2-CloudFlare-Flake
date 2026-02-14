# Plan Status

Last updated: **2026-02-15**

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
- `/run/secrets/r2/explorer.env` (Worker admin signing inputs for `r2 share worker ...`)

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
- Access split remains enforced:
  `curl -I https://files.unsigned.sh/api/list` returns `401` (or Access redirect)

## What's Next

Consumer repo (`~/nixos`) completion items:

- Commit + push the Phase 8 wiring (including the `secrets` submodule pointer and `flake.lock` updates) so the system state is reproducible from Git.
- Extend `services.r2-sync.mounts.*` and `services.r2-restic.paths` for any additional production paths beyond `/data/r2/workspace`.

Operations:

- Schedule Worker admin key rotation using `docs/operators/key-rotation.md`.
  Requirement: always use `wrangler kv ... --remote` for KV updates so you modify the deployed Worker, not local Miniflare storage.
- Keep Cloudflare Access policy split on `files.unsigned.sh`:
- `/*` allow trusted identities
- `/share/*` bypass for public token links
- `/api/share/*` bypass so `r2 share worker ...` HMAC admin flows work without an Access browser session

Optional upstream follow-ups:

- Cut a release version after consumer repo changes are merged, so `~/nixos` can pin a stable tag.
- Add a small CI/runbook lint rule to flag KV write commands that omit `--remote`.
