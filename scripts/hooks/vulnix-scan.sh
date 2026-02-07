#!/usr/bin/env bash
set -euo pipefail

WHITELIST="scripts/ci/vulnix-whitelist.toml"

if [[ ! -f $WHITELIST ]]; then
  echo "vulnix: whitelist file missing: $WHITELIST" >&2
  exit 1
fi

out_path="$(nix path-info .#r2 2>/dev/null || true)"
if [[ -z $out_path ]]; then
  echo "vulnix: skipping — .#r2 not built (run 'nix build .#r2' first)"
  exit 0
fi

if ! vulnix -C "$out_path" -w "$WHITELIST"; then
  echo "vulnix: unwhitelisted CVEs found (warning only, not blocking commit)"
  echo "  Review findings above and update vulnix-whitelist.toml for false positives."
fi
