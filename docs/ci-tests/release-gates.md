# Release Gates

Release automation validates root and worker artifacts before publishing tags.

## Required checks

- release preflight on semver and branch constraints
- worker build with typecheck/tests
- packaged CLI smoke checks in `verify-cli-smoke`

## CLI smoke commands

```bash
nix build .#r2
nix run .#r2 -- help
nix run .#r2 -- bucket help
nix run .#r2 -- share help
nix run .#r2 -- share worker help
```

## Worker release build commands

```bash
pnpm -C r2-explorer run check
pnpm -C r2-explorer test
pnpm -C r2-explorer run build:web
```

## Failure handling

- stop publish and tag steps on any smoke failure
- inspect workflow artifacts and logs
- use rollback runbooks for runtime-impacting regressions

## References

- Google developer documentation style guide: <https://developers.google.com/style>
- GitHub Actions workflow syntax: <https://docs.github.com/en/actions/reference/workflow-syntax-for-github-actions>
