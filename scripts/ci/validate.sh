#!/usr/bin/env bash
set -euo pipefail

# Force deterministic cache settings for CI and local reproducibility.
# This avoids inheriting slow/unreachable user-level extra substituters.
if [[ "${CI_STRICT:-0}" == "1" ]]; then
  echo "CI_STRICT=1 enabled: fail fast on cache/network failures."
  CACHE_TUNING=$'connect-timeout = 8\nstalled-download-timeout = 12\ndownload-attempts = 1\nfallback = false\n'
else
  CACHE_TUNING=$'connect-timeout = 15\nstalled-download-timeout = 30\ndownload-attempts = 8\nfallback = true\n'
fi

PINNED_NIX_CONFIG=$'substituters = https://cache.nixos.org/\nextra-substituters =\ntrusted-public-keys = cache.nixos.org-1:6NCHdD59X431o0gWypbYQ2I6D8sfr8Y9f3l8S8d5N9Q=\nextra-trusted-public-keys =\nhttp-connections = 50\n'"${CACHE_TUNING}"

if [[ -n "${NIX_CONFIG:-}" ]]; then
  export NIX_CONFIG="${NIX_CONFIG}"$'\n'"${PINNED_NIX_CONFIG}"
else
  export NIX_CONFIG="${PINNED_NIX_CONFIG}"
fi

run() {
  echo "+ $*"
  "$@"
}

run nix flake check
run nix build .#r2-bucket
run nix build .#r2-cli
run nix build .#r2-share
run nix run .#r2-bucket -- help
run nix run .#r2-share -- --help
