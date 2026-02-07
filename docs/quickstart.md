# Quickstart

Phase 5 provides package-backed CLIs with Home Manager wrapper integration and
an implemented R2-Explorer Worker subflake.

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
`r2 share ...`, `r2 share worker ...`, and `r2 rclone ...`.

Real bucket/share operations require a readable credentials file
(`R2_CREDENTIALS_FILE`, default `~/.config/cloudflare/r2/env`).

## Worker Explorer

```bash
cd r2-explorer
nix develop
pnpm install
pnpm run check
pnpm test
wrangler deploy
```

Populate `r2-explorer/wrangler.toml` bindings first (`FILES_BUCKET`,
`R2E_SHARES_KV`, `R2E_KEYS_KV`) and initialize
`R2E_KEYS_KV` key `admin:keyset:active` before deploying.
