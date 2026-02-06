# Quickstart

Phase 1 provides scaffold and interfaces only.

```bash
./scripts/ci/validate.sh
```

The script hard-pins Nix cache settings for resilient CI/local execution.

Use strict mode for fail-fast behavior in CI-like checks:

```bash
CI_STRICT=1 ./scripts/ci/validate.sh
```
