#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

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

nix_eval_expect() {
  local label="$1"
  local expected="$2"
  local expr="$3"
  local actual

  echo "+ nix eval (${label})"
  actual="$(nix eval --impure --raw --expr "${expr}")"

  if [[ "${actual}" != "${expected}" ]]; then
    echo "Unexpected nix eval result for ${label}" >&2
    echo "Expected: ${expected}" >&2
    echo "Actual:   ${actual}" >&2
    exit 1
  fi
}

R2_SYNC_POSITIVE_EXPR="$(cat <<'NIX'
let
  flake = builtins.getFlake (toString ./.);
  lib = flake.inputs.nixpkgs.lib;
  systemEval = lib.nixosSystem {
    system = "x86_64-linux";
    modules = [
      { system.stateVersion = "25.05"; }
      flake.outputs.nixosModules.r2-sync
      {
        services.r2-sync = {
          enable = true;
          accountId = "abc123";
          credentialsFile = "/run/secrets/r2";
          mounts.documents = {
            bucket = "my-documents";
            mountPoint = "/mnt/r2/documents";
          };
        };
      }
    ];
  };
in
systemEval.config.systemd.services."r2-mount-documents".description
NIX
)"

R2_RESTIC_POSITIVE_EXPR="$(cat <<'NIX'
let
  flake = builtins.getFlake (toString ./.);
  lib = flake.inputs.nixpkgs.lib;
  systemEval = lib.nixosSystem {
    system = "x86_64-linux";
    modules = [
      { system.stateVersion = "25.05"; }
      flake.outputs.nixosModules.r2-restic
      {
        services.r2-restic = {
          enable = true;
          accountId = "abc123";
          credentialsFile = "/run/secrets/r2";
          passwordFile = "/run/secrets/restic";
          bucket = "backups";
          paths = [ "/home/alice/important" ];
        };
      }
    ];
  };
in
systemEval.config.systemd.timers.r2-restic-backup.description
NIX
)"

R2_SYNC_ASSERTION_EXPR="$(cat <<'NIX'
let
  flake = builtins.getFlake (toString ./.);
  lib = flake.inputs.nixpkgs.lib;
  systemEval = lib.nixosSystem {
    system = "x86_64-linux";
    modules = [
      { system.stateVersion = "25.05"; }
      flake.outputs.nixosModules.r2-sync
      {
        services.r2-sync = {
          enable = true;
          accountId = "abc123";
          credentialsFile = "/run/secrets/r2";
        };
      }
    ];
  };
  failed = builtins.filter (a: !(a.assertion)) systemEval.config.assertions;
  expected = "services.r2-sync.mounts must define at least one mount when services.r2-sync.enable = true";
in
if builtins.any (a: a.message == expected) failed then "ok" else builtins.throw "Missing expected r2-sync assertion"
NIX
)"

R2_RESTIC_ASSERTION_EXPR="$(cat <<'NIX'
let
  flake = builtins.getFlake (toString ./.);
  lib = flake.inputs.nixpkgs.lib;
  systemEval = lib.nixosSystem {
    system = "x86_64-linux";
    modules = [
      { system.stateVersion = "25.05"; }
      flake.outputs.nixosModules.r2-restic
      {
        services.r2-restic = {
          enable = true;
          accountId = "abc123";
          credentialsFile = "/run/secrets/r2";
          passwordFile = "/run/secrets/restic";
          bucket = "backups";
          paths = [ ];
        };
      }
    ];
  };
  failed = builtins.filter (a: !(a.assertion)) systemEval.config.assertions;
  expected = "services.r2-restic.paths must contain at least one path when services.r2-restic.enable = true";
in
if builtins.any (a: a.message == expected) failed then "ok" else builtins.throw "Missing expected r2-restic assertion"
NIX
)"

run nix flake check
run nix build .#r2-bucket
run nix build .#r2-cli
run nix build .#r2-share
run nix run .#r2-bucket -- help
run nix run .#r2-share -- --help
nix_eval_expect "r2-sync module (positive)" "R2 FUSE mount for documents" "${R2_SYNC_POSITIVE_EXPR}"
nix_eval_expect "r2-restic module (positive)" "Restic backup timer" "${R2_RESTIC_POSITIVE_EXPR}"
nix_eval_expect "r2-sync assertions (negative)" "ok" "${R2_SYNC_ASSERTION_EXPR}"
nix_eval_expect "r2-restic assertions (negative)" "ok" "${R2_RESTIC_ASSERTION_EXPR}"
