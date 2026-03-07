# Local Validation Targets

Use `./scripts/ci/validate.sh` to run the same target categories used by CI.

## Target map

| Target                     | What it validates                                            | Typical failures                                                |
| -------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------- |
| `root-format-lint`         | `nix fmt` and pre-commit parity in temp checkout             | formatting drift, lint rule violations                          |
| `root-flake-template-docs` | flake checks, template init/build checks, docs quality gates | stale docs links, missing required docs, template eval failures |
| `root-cli-module-eval`     | CLI build/help and module assertion evals                    | module assertion regressions, CLI eval failures                 |
| `worker-typecheck-test`    | worker typecheck, web build, API tests                       | TypeScript errors, API test regressions                         |

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
- Avoid adding stale milestone wording outside planning docs.

## References

- Google developer documentation style guide: <https://developers.google.com/style>
