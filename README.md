# r2-cloud-nix

Standalone Nix flake scaffold for Cloudflare R2 storage, sync, backup, and sharing.

## Status

This repository is currently in **Phase 1** from `docs/plan.md`:
- repository scaffold
- flake outputs and interfaces
- placeholder modules/packages/templates

Functional implementations for sync/backup/versioning/Worker are planned for Phases 2-7.

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

Set `CI_STRICT=1` to fail fast on cache/network issues instead of falling back to
local builds:

```bash
CI_STRICT=1 ./scripts/ci/validate.sh
```
