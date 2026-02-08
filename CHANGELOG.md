# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog,
and this project follows Conventional Commits.

## [Unreleased]

### Added

- _No changes yet._

### Changed

- Secrets now standardize on `secrets/r2.yaml` with `/run/secrets/r2/*` outputs,
  and system credentials rendered to `/run/secrets/r2/credentials.env`.
- NixOS and Home Manager modules now support `accountIdFile` and runtime
  endpoint resolution for endpoint-less rclone remotes.

### Fixed

- _No changes yet._

## [v0.1.0] - 2026-02-07

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
- Option reference documentation under `docs/reference/`:
  - `services.r2-sync`
  - `services.r2-restic`
  - `programs.r2-cloud`
  - `programs.r2-cloud.credentials`
  - managed rclone config behavior for `programs.r2-cloud`
  - `programs.git-annex-r2`
- Troubleshooting matrix documentation in `docs/troubleshooting.md` with
  command-level diagnostic and repair workflows for:
  - authentication
  - lifecycle
  - bisync
  - restic
  - multipart upload
  - share token validation
- Targeted CI validation interface in `scripts/ci/validate.sh`:
  - `--target <name>` (repeatable) for scoped checks
  - `--list-targets` for discoverability
  - matrix-aligned targets for root and `r2-explorer` validation
- Worker deploy automation baseline for Phase 7.2:
  - `r2-explorer/.github/workflows/deploy.yml` now includes
    PR-driven preview deploys and manual production deploys
  - environment-scoped Cloudflare secrets contract
    (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`)
  - production deploy guard requiring `workflow_dispatch` with `ref=main`
- Root `.gitignore` now ignores `node_modules/` directories.
- `treefmt` now runs `actionlint` against workflow files and `taplo format`
  against TOML files.
- Phase 7.3 security gates:
  - root CI job `security-dependency-audit` now enforces:
    - `flake-checker` lock/input policy checks for root and worker lockfiles
    - Worker `pnpm audit`
    - Nix closure `vulnix` scan with
      `scripts/ci/vulnix-whitelist.toml` baseline
  - root CI job `security-sensitive-change-policy` enforcing sensitive-file
    PR label requirements
  - CODEOWNERS protection for workflow and lockfile updates
  - pre-commit `ripsecrets` scanning via `lefthook`
  - operator remediation runbook in
    `docs/operators/security-gates-remediation.md`
- Manual release automation workflow:
  - `.github/workflows/release.yml` with semver-gated `workflow_dispatch`
  - root/worker release artifact build jobs
  - changelog promotion + release-note extraction helpers in
    `scripts/release/`

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
- Documentation navigation now points to `docs/reference/index.md` from
  `README.md` and core user guides.
- Repository docs status wording was updated to capability-based descriptions
  and stale milestone language removed from user-facing docs.
- `scripts/ci/validate.sh` now includes a documentation quality gate that
  hard-fails on stale `Phase <n>` language outside `docs/plan.md`, verifies
  required option-reference pages, and checks required reference links.
- `docs/plan.md` milestone status now marks `6.2` and `6.6` complete.
- User/operator docs now link to `docs/troubleshooting.md` as the first-line
  triage entrypoint:
  - `docs/quickstart.md`
  - `docs/sync.md`
  - `docs/versioning.md`
  - `docs/sharing.md`
  - `docs/operators/index.md`
- Documentation status tracking now reflects completed troubleshooting
  and runbook milestones in `README.md` and marks Phase `6.5` complete
  in `docs/plan.md`.
- End-user workflow docs now include explicit template-separated local and
  remote checkpoints, including worker-share behavior validation:
  - `docs/quickstart.md`
  - `docs/sync.md`
  - `docs/versioning.md`
- `.github/workflows/ci.yml` now executes a target matrix across:
  - `root-format-lint`
  - `root-flake-template-docs`
  - `root-cli-module-eval`
  - `worker-typecheck-test`
- `docs/plan.md` now marks milestone `7.1` complete.
- Phase 6 documentation status is now fully closed:
  - `docs/plan.md` marks `6.4` complete and sets Phase 6 complete in
    implementation order
  - stale `6.4` reopen note removed and replaced with closure note
  - `README.md` now states Phase 6 is complete and Stage 7 remains open
- `r2-explorer/wrangler.toml` now defines explicit `[env.preview]`
  bindings/vars for CI preview deployments.
- `docs/plan.md` now marks milestone `7.2` complete and includes a
  decision-complete Worker deploy pipeline specification.
- `flake.nix` formatter/hook toolchains now include `actionlint` and `taplo`
  so `nix fmt` and hook/CI runs can execute the expanded `treefmt` config.
- `docs/plan.md` now marks milestones `7.3` and `7.6` complete, with closure
  notes documenting required checks and branch protection controls.
- Versioning and repository docs now document automated release operations:
  - `docs/versioning.md` release input contract and failure semantics
  - `README.md` release automation entrypoints
  - `docs/plan.md` milestone `7.4` marked complete with closure note

### Fixed

- Home Manager `programs.r2-cloud` package list now correctly wraps
  `pkgs.writers.writeBashBin` as a package derivation.
- Standalone import of `homeManagerModules.rclone-config` no longer fails
  when `programs.r2-cloud` options are absent.
- Deadnix findings in templates/library were fixed by removing unused lambda
  patterns (`self` in template flakes and unused arg in `lib/r2.nix`).
- `scripts/lefthook-rc.sh` now refreshes cached hook PATH when either
  `flake.nix` or `flake.lock` changes, avoiding stale-tool failures after
  formatter/linter toolchain updates.
