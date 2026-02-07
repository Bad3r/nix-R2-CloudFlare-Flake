# r2-cloud-nix

Standalone Nix flake for Cloudflare R2 storage, sync, backup, and sharing.

## Capabilities

- NixOS sync module: `services.r2-sync` (rclone mount + bisync services/timers)
- NixOS backup module: `services.r2-restic` (scheduled restic snapshots to R2)
- NixOS annex helper module: `programs.git-annex-r2`
- Home Manager CLI surface: `programs.r2-cloud` (`r2` wrapper + tool installation)
- Home Manager credentials assembly: `programs.r2-cloud.credentials`
- Home Manager managed `rclone.conf`: generated from `programs.r2-cloud` options
- Worker subflake: R2-Explorer routes, share token lifecycle, and tests

## Documentation Status

- Completed: template hardening, option reference docs, operator runbooks,
  troubleshooting matrix, and docs quality gate.
- In progress: end-user workflow refinements (see `docs/plan.md` Phase `6.4`
  reopen note).

## Layout

- `flake.nix`: main flake outputs
- `modules/`: NixOS and Home Manager modules
- `packages/`: CLI package derivations
- `lib/r2.nix`: shared library helpers
- `r2-explorer/`: Worker subflake and deployment tooling
- `templates/`: starter flake templates
- `docs/`: usage and design documentation
  - includes first-line triage in `docs/troubleshooting.md`

## Option Reference

- `docs/reference/index.md` is the canonical option reference entrypoint.

## Quick Validation

```bash
./scripts/ci/validate.sh
```

`scripts/ci/validate.sh` pins `substituters` to `https://cache.nixos.org/` and clears
`extra-substituters` so validation does not inherit flaky host-level cache mirrors.
It also evaluates concrete NixOS module configurations for `r2-sync` and `r2-restic`
and `programs.git-annex-r2`, plus Home Manager module assertions for
`programs.r2-cloud` and `programs.r2-cloud.credentials` to catch
option/schema regressions early, and
runs documentation quality checks (stale-language scan + reference/docs-link checks),
runs both formatting (`nix fmt`) and
all pre-commit hooks (`lefthook run pre-commit --all-files`) in an isolated temp checkout.
The validation flow also runs Worker checks/tests in `r2-explorer`
(`pnpm run check`, `pnpm test`) through `nix develop ./r2-explorer`.
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
