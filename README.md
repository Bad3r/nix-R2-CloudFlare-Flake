# r2-cloud-nix

Standalone Nix flake for Cloudflare R2 storage, sync, backup, and sharing.

## Status

This repository is currently in **Phase 4** from `docs/plan.md`:

- Phase 1 scaffold completed.
- Phase 2 NixOS modules implemented:
  - `services.r2-sync` (rclone mount + bisync services and timers)
  - `services.r2-restic` (restic backup service and timer)
- Phase 3 Home Manager modules implemented:
  - `programs.r2-cloud` wrapper for the `r2` CLI
  - `programs.r2-cloud.credentials` env-file assembly from secret file inputs
  - managed `rclone.conf` generation via `modules/home-manager/rclone-config.nix`
- Phase 4 CLI package extraction/refactor implemented with `r2`-only command format:
  - `packages/r2-cli.nix` provides the single `r2` subcommand CLI
  - compatibility-specific binaries/aliases were removed
  - Home Manager injects config defaults and delegates execution to the package
- Phases 5-7 remain in progress.

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
as well as Home Manager module assertions for Phase 4 CLI wiring (`programs.r2-cloud`
and `programs.r2-cloud.credentials`) to catch option/schema regressions early, and
runs both formatting (`nix fmt`) and
all pre-commit hooks (`lefthook run pre-commit --all-files`) in an isolated temp checkout.
If cache access is unavailable, validation disables substituters for that run to avoid
repeated timeout loops. Override cache selection with `NIX_VALIDATE_SUBSTITUTERS`.

Set `CI_STRICT=1` to fail fast on cache/network issues instead of falling back to
local builds:

```bash
CI_STRICT=1 ./scripts/ci/validate.sh
```

## Dev Quality Gates

```bash
nix develop
lefthook install
lefthook run pre-commit --all-files
```

- `nix fmt` now uses `treefmt` (configured by `.treefmt.toml`).
- Pre-commit hooks run `treefmt`, `deadnix`, and `statix`.
- Hook environment is loaded via `scripts/lefthook-rc.sh` for reproducible tool paths.
- Hooks use the lightweight `nix develop .#hooks` environment to avoid pulling
  heavy non-hook tooling.
