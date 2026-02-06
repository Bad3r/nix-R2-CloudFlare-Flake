# Repository Guidelines

## Project Overview

This repo is documentation-only today. The source of truth is `docs/plan.md`, which defines a 7‑phase implementation plan for a standalone Nix flake that integrates Cloudflare R2 storage, sync, backup, and a Worker-based web UI. Keep updates aligned with the plan and note when changes affect future phases.

## Key Technologies

- **Nix**: flakes, NixOS modules, Home Manager, flake-parts
- **rclone**: S3 mount and bisync
- **restic**: backup snapshots
- **git-annex**: large file versioning
- **Cloudflare**: R2 (storage), Workers (web UI), Access (auth)
- **Wrangler**: Worker deployment

## Project Structure & Module Organization

Current files:

- `docs/plan.md`: architecture, CLI design, and implementation phases.
- `AGENTS.md`, `CLAUDE.md`: contributor guidance.
- `.mcp.json`: MCP configuration for Cloudflare agents.

Planned structure (per `docs/plan.md`): `modules/nixos/`, `modules/home-manager/`, `packages/`, `lib/r2.nix`, `r2-explorer/` (Worker subflake), `templates/`.

## Build, Test, and Development Commands

No build/test commands exist yet. When implementation begins, expected commands include:

- `nix flake check` to validate flake structure.
- `nix build .#r2` to build the CLI.
- `nix run .#r2 -- help` to smoke‑test CLI usage.
- `nix develop` for a dev shell with rclone/restic/git-annex/wrangler.

## Local Development Tools

Available via `nix run nixpkgs#<package>` or system install:

- **wrangler**: Cloudflare Workers CLI. Deploy, dev, and manage Workers and R2 buckets. `wrangler r2 bucket list`, `wrangler dev`, `wrangler deploy`.
- **cloudflared**: Cloudflare Tunnel daemon. Expose local services, access private resources, test Access policies.
- **flarectl**: Cloudflare API CLI. Manage DNS, zones, and account settings. Useful for scripting Cloudflare configuration.
- **rclone**: File sync and mount. Test R2 connectivity with `rclone lsd r2:` or mount with `rclone mount`.
- **restic**: Backup tool. Test backup/restore workflows to R2.
- **git-annex**: Large file management. Test special remote setup with `git annex initremote`.
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

No tests exist yet. If you add tests, document the framework, file naming, and exact commands to run full and focused suites.

## Commit & Pull Request Guidelines

Use Conventional Commits (example: `chore(docs): update sharing notes`). PRs should summarize changes, reference affected `docs/plan.md` sections, and link issues when applicable.

## Security & Configuration Notes

Do not commit secrets. The plan references credentials under `~/.config/cloudflare/r2/env`; keep templates sanitized and document required environment variables explicitly.
