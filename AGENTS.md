# Repository Guidelines

## Project Overview

This repository now includes both implementation and documentation for a standalone Nix flake that integrates Cloudflare R2 storage, sync, backup, versioning, and Worker-based sharing.

Roadmap/state tracking:

- `docs/plan.md` is the source of truth for architecture and phased milestones.
- Phases `1` through `7` are complete; Phase `8` (consumer integration in `~/nixos`) is in progress.
- `docs/plan-8-1.md` contains the detailed execution plan for milestone `8.1`.

When behavior changes, update the relevant docs in the same change set. If the change affects phase assumptions or milestone status, update `docs/plan.md`.

## Key Technologies

- **Nix**: flakes, NixOS modules, Home Manager, flake-parts
- **rclone**: S3 mount and bisync
- **restic**: backup snapshots
- **git-annex**: large file versioning
- **Cloudflare**: R2 (storage), Workers (web UI), Access (auth)
- **Wrangler**: Worker deployment
- **TypeScript**: Worker implementation
- **Hono + Zod + Vitest**: Worker HTTP surface, validation, and tests
- **pnpm**: Worker dependency and script runner

## Project Structure & Module Organization

Current repository layout:

- `flake.nix`: root flake outputs (packages, modules, templates, dev shells).
- `modules/nixos/`: `r2-sync`, `r2-restic`, `git-annex` NixOS modules.
- `modules/home-manager/`: `r2-cli`, `r2-credentials`, `rclone-config` HM modules.
- `packages/r2-cli.nix`: packaged `r2` CLI.
- `lib/r2.nix`: shared library helpers.
- `r2-explorer/`: Worker subflake, source, tests, and deploy config.
- `templates/minimal`, `templates/full`: consumer flake templates.
- `scripts/ci/validate.sh`: CI-equivalent local validation entrypoint.
- `docs/reference/index.md`: canonical option reference entrypoint.
- `docs/operators/`: operational runbooks for key rotation, incident response, rollback, and maintenance.
- `AGENTS.md`, `CLAUDE.md`: contributor guidance.
- `.mcp.json`: MCP configuration for Cloudflare agents.

## Build, Test, and Development Commands

Primary validation (matches CI target coverage):

- `./scripts/ci/validate.sh`
- `./scripts/ci/validate.sh --list-targets`
- `./scripts/ci/validate.sh --target root-format-lint`
- `./scripts/ci/validate.sh --target root-flake-template-docs`
- `./scripts/ci/validate.sh --target root-cli-module-eval`
- `./scripts/ci/validate.sh --target worker-typecheck-test`

Root flake checks:

- `nix flake check` to validate flake structure.
- `nix build .#r2` to build the CLI.
- `nix run .#r2 -- help` to smoke‑test CLI usage.
- `nix develop` for a dev shell with rclone/restic/git-annex/wrangler.
- `nix develop .#hooks --command lefthook run pre-commit --all-files` for hook parity.

Worker checks (`r2-explorer/`):

- `nix develop ./r2-explorer`
- `pnpm -C r2-explorer install`
- `pnpm -C r2-explorer run check`
- `pnpm -C r2-explorer test`
- `pnpm -C r2-explorer run dev`
- `nix run ./r2-explorer#deploy` for deploy helper flow.

## Local Development Tools

Available via `nix run nixpkgs#<package>` or system install:

- **wrangler**: Cloudflare Workers CLI. Deploy, dev, and manage Workers and R2 buckets. `wrangler r2 bucket list`, `wrangler dev`, `wrangler deploy`.
- **cloudflared**: Cloudflare Tunnel daemon. Expose local services, access private resources, test Access policies.
- **flarectl**: Cloudflare API CLI. Manage DNS, zones, and account settings. Useful for scripting Cloudflare configuration.
- **rclone**: File sync and mount. Test R2 connectivity with `rclone lsd r2:` or mount with `rclone mount`.
- **restic**: Backup tool. Test backup/restore workflows to R2.
- **git-annex**: Large file management. Test special remote setup with `git annex initremote`.
- **pnpm/nodejs**: Worker package management, typecheck, tests, and local dev.
- **act**: Run GitHub Actions workflows locally. Test CI before pushing with `act -l` (list) or `act` (run).

Nix shortcuts:

- `nix run nixpkgs#wrangler -- r2 bucket list` — run any package without installing.
- `nix develop` — enter project dev shell with all tools available.
- `nix develop nixpkgs#nodejs` — ad-hoc shell with specific packages.

## Architecture & Sharing Modes

High-level components:

- Local system: rclone mount + bisync, git‑annex, restic.
- Cloudflare R2: `files/`, `.trash/`, `.git-annex/`.
- Cloudflare edge: R2‑Explorer Worker + Access.

Sync strategies:

- **git-annex**: For git repos with large files. Replaces files with symlinks, stores content in `.git/annex/objects/`, syncs to R2 via rclone special remote. Provides per-file versioning with `git annex get/drop` for selective fetching.
- **rclone bisync**: For non-git folders (Downloads, Photos). 2-way sync with `--backup-dir` sending deleted files to `.trash/`. Runs on a systemd timer.
- **rclone mount**: Direct FUSE access to R2. Uses VFS cache for performance. Good for occasional access without local copy.

Sharing modes:

- Presigned URLs via `r2 share`: S3 endpoint only, no Access.
- Access‑protected links: custom domain via Worker + HMAC.

## Documentation Requirements

- Keep behavior docs synchronized with implementation, especially:
  - `docs/reference/*.md` for option/default/assertion semantics.
  - `docs/operators/*.md` for operational workflows and rollback/security procedures.
- Preserve `docs/reference/index.md` as the option-reference entrypoint and keep links from:
  - `README.md`
  - `docs/quickstart.md`
  - `docs/credentials.md`
- Do not leave stale "Phase N" wording outside planning docs. CI checks reject stale phase references in general docs (`README.md`, `docs/*.md` excluding `docs/plan*.md`).
- When adding/changing public options, update the matching reference page in the same PR.

## Local Documentation

Clone repos available in `~/git/`. Update with `git -C ~/git/<repo> pull`.

| Tool        | Path                | Docs Location                                        |
| ----------- | ------------------- | ---------------------------------------------------- |
| rclone      | `~/git/rclone`      | `docs/content/` (Hugo site)                          |
| restic      | `~/git/restic`      | `doc/*.rst` (Sphinx)                                 |
| git-annex   | `~/git/git-annex`   | `doc/*.mdwn` (ikiwiki)                               |
| libfuse     | `~/git/libfuse`     | `doc/`, `README.md`                                  |
| wrangler    | `~/git/wrangler`    | `packages/wrangler/README.md` (workers-sdk monorepo) |
| sops-nix    | `~/git/sops-nix`    | `README.md`                                          |
| GitHub docs | `~/git/github-docs` | `content/actions/` (workflows)                       |

## Coding Style & Naming Conventions

Keep Markdown concise, with clear headings and fenced code blocks for commands. Use lower‑case, hyphenated names (for example `r2-explorer/`, `r2-cli.nix`) consistent with the plan.

## Error Handling & Failure Semantics

- Fail fast: no silent or masked failures.
- Validate required config early (prefer Nix `assertions`).
- Errors must name the exact missing/invalid input.
- Do not hide root cause (`null` interpolation, implicit coercions, swallowed exits like `|| true` or broad stderr redirection), except scoped non-fatal cleanup.

## Testing Guidelines

Existing tests/checks:

- Root validation and policy checks: `./scripts/ci/validate.sh`.
- Worker typecheck/tests: `pnpm -C r2-explorer run check` and `pnpm -C r2-explorer test`.
- Optional live integration: `pnpm -C r2-explorer run test:live` (requires real Worker env).

When adding tests, document:

- test scope (module eval, CLI behavior, Worker API, or live integration),
- exact command(s) to run locally,
- required environment variables/secrets for live tests.

## Commit & Pull Request Guidelines

Use Conventional Commits (example: `chore(docs): update sharing notes`). PRs should summarize changes, reference affected `docs/plan.md` sections, and link issues when applicable.

## Security & Configuration Notes

Do not commit secrets. Keep templates sanitized and document required environment variables explicitly.

Current secret model:

- System secrets are standardized in `secrets/r2.yaml` (SOPS-managed source).
- Runtime files are materialized under `/run/secrets/r2/*`.
- System services consume `/run/secrets/r2/credentials.env`.
- Home Manager can still manage user-scoped `~/.config/cloudflare/r2/env` when enabled.

Worker/deploy safety:

- Do not commit concrete Cloudflare binding IDs, bucket names, or credentials to `wrangler.toml`.
- Keep deployment-specific values in GitHub Environments/CI-rendered config as documented in `r2-explorer/README.md`.
