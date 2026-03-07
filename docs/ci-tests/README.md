# CI and Test Overview

This section documents CI checks, local test flows, and environment contracts.
CI testing runs on preview. Production CI is deploy-only.

## Test categories

| Category                   | Purpose                                                | Primary command or job                                              |
| -------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| Root validation            | Format, lint, flake checks, template docs, module eval | `./scripts/ci/validate.sh`                                          |
| Worker static + unit tests | Typecheck and mocked API/web tests                     | `pnpm -C r2-explorer run check`, `pnpm -C r2-explorer run test:api` |
| Deploy contract checks     | Preview Access policy and CSP/CORS deploy checks       | `check-r2-access-policy.sh`, `check-r2-web-security.sh`             |
| Smoke + live integration   | Preview real-host share and multipart validation       | `worker-share-smoke.sh`, `pnpm -C r2-explorer run test:live`        |
| Security gates             | Dependency and closure security checks                 | CI `security-dependency-audit`                                      |
| Release gates              | Packaged CLI smoke and release checks                  | CI `verify-cli-smoke`                                               |

## Run by scope

```bash
./scripts/ci/validate.sh --list-targets
./scripts/ci/validate.sh --target root-format-lint
./scripts/ci/validate.sh --target root-flake-template-docs
./scripts/ci/validate.sh --target root-cli-module-eval
./scripts/ci/validate.sh --target worker-typecheck-test
```

```bash
pnpm -C r2-explorer run check
pnpm -C r2-explorer run test:api
pnpm -C r2-explorer run test:live
```

`test:live` in CI uses preview `CF_PREVIEW_CI_*` credentials only.

## Where to look next

- [Local validation targets](./local-validation.md)
- [Worker test suites](./worker-test-suites.md)
- [Deploy and smoke tests](./deploy-and-smoke-tests.md)
- [Security gates](./security-gates.md)
- [Release gates](./release-gates.md)
- [Environment matrix and parity checklist](./environment-matrix.md)

## References

- Google developer documentation style guide: <https://developers.google.com/style>
- GitHub Actions environments: <https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments>
