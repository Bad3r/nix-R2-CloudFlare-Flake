# r2-cloud-nix

Standalone Nix flake for Cloudflare R2 storage, sync, backup, and sharing.

## Status

This repository is currently in **Phase 2** from `docs/plan.md`:
- Phase 1 scaffold completed.
- Phase 2 NixOS modules implemented:
  - `services.r2-sync` (rclone mount + bisync services and timers)
  - `services.r2-restic` (restic backup service and timer)
- Phases 3-7 remain in progress.

## Layout

- `flake.nix`: main flake outputs
- `modules/`: NixOS and Home Manager modules
- `packages/`: CLI package derivations
- `lib/r2.nix`: shared library helpers
- `r2-explorer/`: Worker subflake scaffold
- `templates/`: starter flake templates
- `docs/`: usage and design documentation

## Quick Validation

```bash
./scripts/ci/validate.sh
```

`scripts/ci/validate.sh` pins `substituters` to `https://cache.nixos.org/` and clears
`extra-substituters` so validation does not inherit flaky host-level cache mirrors.
It also evaluates concrete NixOS module configurations for `r2-sync` and `r2-restic`
to catch option/schema regressions early.

Set `CI_STRICT=1` to fail fast on cache/network issues instead of falling back to
local builds:

```bash
CI_STRICT=1 ./scripts/ci/validate.sh
```
