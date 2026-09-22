# Local Validation Targets

Use `./scripts/ci/validate.sh` to run the same target categories used by CI.

## Target map

| Target                     | What it validates                                                         | Typical failures                                                |
| -------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `root-format-lint`         | pre-commit parity (format, nix lint, secrets) in an isolated snapshot     | formatting drift, lint rule violations                          |
| `root-flake-template-docs` | flake checks, template init/build checks, docs quality gates              | stale docs links, missing required docs, template eval failures |
| `root-cli-module-eval`     | CLI build/help and hermetic CLI behavior checks, module assertion evals   | module assertion regressions, generated unit or script drift    |
| `worker-typecheck-test`    | worker typecheck, web build, API tests (mutates the real tree, see below) | TypeScript errors, API test regressions                         |

## Commands

```bash
./scripts/ci/validate.sh --target root-format-lint
./scripts/ci/validate.sh --target root-flake-template-docs
./scripts/ci/validate.sh --target root-cli-module-eval
./scripts/ci/validate.sh --target worker-typecheck-test
```

For full local parity:

```bash
./scripts/ci/validate.sh
```

## Notes

- Validation intentionally fails fast for unknown targets and missing prerequisites.
- Keep docs links to `docs/reference/index.md` in required files to satisfy docs checks.
- Avoid adding stale milestone wording outside planning docs; the check also covers the
  `description` in `flake.nix` and `r2-explorer/flake.nix`, not only Markdown files.
- `root-format-lint` checks formatting; it does not run `nix fmt` for you. On failure it names
  the offending file(s); run `nix fmt` and re-stage.
- `worker-typecheck-test` runs `pnpm install --frozen-lockfile` directly in `r2-explorer/`, the
  real working tree, unlike the other three targets, which validate an isolated snapshot copy.
  Expect it to change `r2-explorer/node_modules` and to conflict with local `pnpm link` setups or
  a mid-edit `node_modules`.
- `root-format-lint` and `root-flake-template-docs` resolve the flake under test through Nix's
  git-aware fetcher (`git+file`), never a plain path copy, so only tracked files, plus anything
  `git add`ed but not yet committed, ever leave the working tree; `.env`, `node_modules`, and other
  git-ignored content are never copied into a temp checkout or the Nix store. A brand-new file is
  invisible until it is `git add`ed, the normal flake rule. `root-flake-template-docs` reads the
  repository ref from the `NIX_VALIDATE_FLAKE_REF` environment variable (set in
  `scripts/ci/validate.sh`, default `git+file://<repo root>`); override it for setups where
  `git+file` cannot fetch the working tree, for example a Lix linked worktree, where `.git` is a
  file rather than a directory and a clean worktree cannot be fetched as `git+file`.

## References

- Google developer documentation style guide: <https://developers.google.com/style>
