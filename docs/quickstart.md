# Quickstart

Phase 4 provides package-backed CLIs with Home Manager wrapper integration.

## Validate

```bash
./scripts/ci/validate.sh
```

The script hard-pins Nix cache settings for resilient CI/local execution and
checks NixOS modules, Home Manager assertions, and CLI package smoke tests.

Use strict mode for fail-fast behavior in CI-like checks:

```bash
CI_STRICT=1 ./scripts/ci/validate.sh
```

## CLI Smoke Tests

```bash
nix build .#r2

nix run .#r2 -- help
nix run .#r2 -- bucket help
```

`r2` is the only CLI interface. Use subcommands such as `r2 bucket ...`,
`r2 share ...`, and `r2 rclone ...`.

Real bucket/share operations require a readable credentials file
(`R2_CREDENTIALS_FILE`, default `~/.config/cloudflare/r2/env`).
