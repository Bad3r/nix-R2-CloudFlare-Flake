# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog,
and this project follows Conventional Commits.

## [Unreleased]

### Added

- Phase 1 scaffold for a standalone flake, including:
  - `flake.nix`, `default.nix`, and lockfiles
  - NixOS/Home Manager module skeletons under `modules/`
  - CLI package skeletons under `packages/`
  - Shared library placeholders in `lib/r2.nix`
  - `r2-explorer/` Worker subflake scaffold
  - Consumer templates under `templates/`
- Base docs for credentials, sync, sharing, and versioning.
- Generic CI validation workflow in `.github/workflows/ci.yml`.
- Reusable validation runner `scripts/ci/validate.sh`.
- Phase 2 NixOS module implementations:
  - `services.r2-sync` with per-mount `r2-mount-*` and `r2-bisync-*` units/timers.
  - `services.r2-restic` with backup service/timer, retention, and schedule controls.
  - Fail-fast assertions for required configuration when services are enabled.

### Changed

- CI naming made phase-agnostic (`ci.yml`, `validate.sh`).
- Validation docs now use `./scripts/ci/validate.sh`.
- CI defaults to `CI_STRICT=1` for fail-fast cache/network behavior.
- `scripts/ci/validate.sh` now includes positive and negative NixOS module eval checks
  for Phase 2 service options and assertions.
- Repository status docs now mark Phase 2 complete in `README.md` and `docs/plan.md`.
- `AGENTS.md` now defines explicit fail-fast error-handling semantics:
  no masked/silent failures, readable errors, and early config validation.

### Fixed

- Home Manager `programs.r2-cloud` package list now correctly wraps
  `pkgs.writers.writeBashBin` as a package derivation.
- Standalone import of `homeManagerModules.rclone-config` no longer fails
  when `programs.r2-cloud` options are absent.
