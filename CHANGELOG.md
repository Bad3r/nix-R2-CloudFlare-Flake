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
- Dev quality-gate configuration:
  - `lefthook.yml` pre-commit hooks (`treefmt`, `deadnix`, `statix`)
  - `.treefmt.toml` formatter configuration
  - `scripts/lefthook-rc.sh` hook runtime PATH cache
  - Flake packages `lefthook-treefmt` and `lefthook-statix`
- Phase 3 Home Manager module implementations:
  - `programs.r2-cloud` wrapped CLI: `r2`
  - `programs.r2-cloud.credentials` secure env-file assembly from file-based secrets
  - managed `rclone.conf` generation (`modules/home-manager/rclone-config.nix`)
- Home Manager module validation coverage in `scripts/ci/validate.sh`:
  - positive evaluation checks for Stage 3 wrapper availability
  - positive evaluation checks for generated R2 `rclone.conf`
  - expected-failure checks for Stage 3 assertion paths
- Phase 4 CLI package extraction/refactor:
  - `packages/r2-cli.nix` implements the `r2` command
  - `r2` subcommands: `bucket`, `share`, and `rclone`

### Changed

- CI naming made phase-agnostic (`ci.yml`, `validate.sh`).
- Validation docs now use `./scripts/ci/validate.sh`.
- CI defaults to `CI_STRICT=1` for fail-fast cache/network behavior.
- `scripts/ci/validate.sh` now includes positive and negative NixOS module eval checks
  for Phase 2 service options and assertions.
- `scripts/ci/validate.sh` now runs `nix fmt` and `lefthook run pre-commit --all-files`
  in a temporary checkout to avoid mutating the caller's working tree.
- Hook execution now uses a dedicated lightweight `nix develop .#hooks` shell
  to avoid unnecessary heavy package pulls during validation.
- Validation now probes cache reachability and disables substituters when unreachable
  to avoid repeated narinfo timeout loops. Cache can be overridden via
  `NIX_VALIDATE_SUBSTITUTERS`.
- Repository status docs now mark Phase 2 complete in `README.md` and `docs/plan.md`.
- `AGENTS.md` now defines explicit fail-fast error-handling semantics:
  no masked/silent failures, readable errors, and early config validation.
- Dev shell now includes `lefthook`, `treefmt`, `deadnix`, `statix`, `nixfmt`, `shfmt`,
  and `prettier`; shell startup installs `lefthook` hooks when needed.
- `nix fmt` now points to `treefmt`.
- Documentation status now marks Phase 3 complete:
  - `README.md` updated to reflect Stage 3 implementation state
  - `docs/plan.md` implementation order now checks Phase 3
- `docs/plan.md` now re-scopes Phase 4 from initial CLI implementation to
  package extraction/refactor of Stage 3 wrapper logic.
- `docs/credentials.md` now documents implemented credential file assembly
  semantics and output permissions.
- Flake package exports now use `r2` as the only CLI package output.
- Home Manager `programs.r2-cloud` now delegates CLI execution to package
  derivations and injects defaults via `R2_CREDENTIALS_FILE`,
  `R2_RCLONE_CONFIG`, and `R2_DEFAULT_ACCOUNT_ID`.
- Validation now builds and smoke-tests the primary `r2` package.
- Phase/status docs now reflect implemented Phase 4 behavior:
  `README.md`, `docs/quickstart.md`, `docs/sharing.md`, and `docs/plan.md`.
- Compatibility-specific CLI implementations were removed:
  - deleted `packages/r2-bucket.nix` and `packages/r2-share.nix`
  - removed Home Manager installation of `r2-bucket`/`r2-share` wrappers
  - removed legacy `r2-cli` compatibility alias output from `flake.nix`

### Fixed

- Home Manager `programs.r2-cloud` package list now correctly wraps
  `pkgs.writers.writeBashBin` as a package derivation.
- Standalone import of `homeManagerModules.rclone-config` no longer fails
  when `programs.r2-cloud` options are absent.
- Deadnix findings in templates/library were fixed by removing unused lambda
  patterns (`self` in template flakes and unused arg in `lib/r2.nix`).
