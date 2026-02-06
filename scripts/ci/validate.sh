#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

CACHE_URL_DEFAULT="https://cache.nixos.org"
CACHE_URL="${NIX_VALIDATE_CACHE_URL:-${CACHE_URL_DEFAULT}}"
CACHE_INFO_URL="${CACHE_URL%/}/nix-cache-info"

# Force deterministic cache settings for CI and local reproducibility.
# This avoids inheriting slow/unreachable user-level extra substituters.
if [[ ${CI_STRICT:-0} == "1" ]]; then
  echo "CI_STRICT=1 enabled: fail fast on cache/network failures."
  CACHE_TUNING=$'connect-timeout = 8\nstalled-download-timeout = 12\ndownload-attempts = 1\nfallback = false\n'
else
  CACHE_TUNING=$'connect-timeout = 15\nstalled-download-timeout = 30\ndownload-attempts = 8\nfallback = true\n'
fi

if [[ -n ${NIX_VALIDATE_SUBSTITUTERS:-} ]]; then
  SUBSTITUTERS_LINE="substituters = ${NIX_VALIDATE_SUBSTITUTERS}"
elif curl -fsSI --max-time 5 "${CACHE_INFO_URL}" >/dev/null 2>&1; then
  SUBSTITUTERS_LINE="substituters = ${CACHE_URL%/}/"
else
  echo "Warning: ${CACHE_INFO_URL} is unreachable. Disabling substituters for this run." >&2
  echo "Set NIX_VALIDATE_SUBSTITUTERS to a reachable cache to avoid source builds." >&2
  SUBSTITUTERS_LINE="substituters ="
fi

PINNED_NIX_CONFIG="${SUBSTITUTERS_LINE}"$'\n'"extra-substituters ="$'\n'"trusted-public-keys = cache.nixos.org-1:6NCHdD59X431o0gWypbYQ2I6D8sfr8Y9f3l8S8d5N9Q="$'\n'"extra-trusted-public-keys ="$'\n'"http-connections = 50"$'\n'"${CACHE_TUNING}"

if [[ -n ${NIX_CONFIG:-} ]]; then
  export NIX_CONFIG="${NIX_CONFIG}"$'\n'"${PINNED_NIX_CONFIG}"
else
  export NIX_CONFIG="${PINNED_NIX_CONFIG}"
fi

run() {
  echo "+ $*"
  "$@"
}

run_quality_checks_in_temp_checkout() {
  local temp_checkout
  temp_checkout="$(mktemp -d "${TMPDIR:-/tmp}/r2-cloud-validate.XXXXXX")"

  cleanup_temp_checkout() {
    rm -rf "${temp_checkout}"
  }

  trap cleanup_temp_checkout RETURN
  run cp -a . "${temp_checkout}/repo"

  (
    cd "${temp_checkout}/repo"
    run nix fmt
    run nix develop .#hooks --command lefthook run pre-commit --all-files
  )

  cleanup_temp_checkout
  trap - RETURN
}

nix_eval_expect() {
  local label="$1"
  local expected="$2"
  local expr="$3"
  local actual

  echo "+ nix eval (${label})"
  actual="$(nix eval --impure --raw --expr "${expr}")"

  if [[ ${actual} != "${expected}" ]]; then
    echo "Unexpected nix eval result for ${label}" >&2
    echo "Expected: ${expected}" >&2
    echo "Actual:   ${actual}" >&2
    exit 1
  fi
}

nix_eval_expect_failure() {
  local label="$1"
  local expected_substring="$2"
  local expr="$3"
  local output
  local status

  echo "+ nix eval (expected failure: ${label})"
  set +e
  output="$(nix eval --impure --raw --expr "${expr}" 2>&1)"
  status=$?
  set -e

  if [[ ${status} -eq 0 ]]; then
    echo "Expected nix eval to fail for ${label}, but it succeeded." >&2
    exit 1
  fi

  if [[ ${output} != *"${expected_substring}"* ]]; then
    echo "nix eval failed for ${label}, but not with the expected message." >&2
    echo "Expected to find: ${expected_substring}" >&2
    echo "Actual output:" >&2
    echo "${output}" >&2
    exit 1
  fi
}

R2_SYNC_POSITIVE_EXPR="$(
  cat <<'NIX'
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

R2_RESTIC_POSITIVE_EXPR="$(
  cat <<'NIX'
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

R2_SYNC_ASSERTION_EXPR="$(
  cat <<'NIX'
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

R2_RESTIC_ASSERTION_EXPR="$(
  cat <<'NIX'
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

HM_R2_CLI_POSITIVE_EXPR="$(
  cat <<'NIX'
let
  flake = builtins.getFlake (toString ./.);
  pkgs = import flake.inputs.nixpkgs { system = "x86_64-linux"; };
  hmEval = flake.inputs.home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      flake.outputs.homeManagerModules.default
      {
        home.username = "alice";
        home.homeDirectory = "/home/alice";
        home.stateVersion = "25.05";
        programs.r2-cloud = {
          enable = true;
          accountId = "abc123";
        };
      }
    ];
  };
  packageNames = builtins.map (pkg: pkg.name) hmEval.config.home.packages;
  hasR2 = builtins.any (name: name == "r2") packageNames;
in
if hasR2 then "ok" else builtins.throw "Missing expected r2 CLI wrapper in home.packages"
NIX
)"

HM_RCLONE_CONFIG_POSITIVE_EXPR="$(
  cat <<'NIX'
let
  flake = builtins.getFlake (toString ./.);
  lib = flake.inputs.nixpkgs.lib;
  pkgs = import flake.inputs.nixpkgs { system = "x86_64-linux"; };
  hmEval = flake.inputs.home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      flake.outputs.homeManagerModules.default
      {
        home.username = "alice";
        home.homeDirectory = "/home/alice";
        home.stateVersion = "25.05";
        programs.r2-cloud = {
          enable = true;
          accountId = "abc123";
          enableRcloneRemote = true;
        };
      }
    ];
  };
  configText = (builtins.getAttr "rclone/rclone.conf" hmEval.config.xdg.configFile).text;
in
if lib.hasInfix "endpoint = https://abc123.r2.cloudflarestorage.com" configText then
  "ok"
else
  builtins.throw "Generated rclone.conf does not contain the expected endpoint"
NIX
)"

HM_R2_CLI_ASSERTION_EXPR="$(
  cat <<'NIX'
let
  flake = builtins.getFlake (toString ./.);
  pkgs = import flake.inputs.nixpkgs { system = "x86_64-linux"; };
  hmEval = flake.inputs.home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      flake.outputs.homeManagerModules.default
      {
        home.username = "alice";
        home.homeDirectory = "/home/alice";
        home.stateVersion = "25.05";
        programs.r2-cloud = {
          enable = true;
          accountId = "";
          enableRcloneRemote = false;
        };
      }
    ];
  };
in
hmEval.activationPackage.name
NIX
)"

HM_R2_CREDENTIALS_ASSERTION_EXPR="$(
  cat <<'NIX'
let
  flake = builtins.getFlake (toString ./.);
  pkgs = import flake.inputs.nixpkgs { system = "x86_64-linux"; };
  hmEval = flake.inputs.home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      flake.outputs.homeManagerModules.default
      {
        home.username = "alice";
        home.homeDirectory = "/home/alice";
        home.stateVersion = "25.05";
        programs.r2-cloud = {
          enable = true;
          accountId = "abc123";
        };
        programs.r2-cloud.credentials.manage = true;
      }
    ];
  };
in
hmEval.activationPackage.name
NIX
)"

run nix flake check
run_quality_checks_in_temp_checkout
run nix build .#r2
run nix run .#r2 -- help
run nix run .#r2 -- bucket help
nix_eval_expect "r2-sync module (positive)" "R2 FUSE mount for documents" "${R2_SYNC_POSITIVE_EXPR}"
nix_eval_expect "r2-restic module (positive)" "Restic backup timer" "${R2_RESTIC_POSITIVE_EXPR}"
nix_eval_expect "r2-sync assertions (negative)" "ok" "${R2_SYNC_ASSERTION_EXPR}"
nix_eval_expect "r2-restic assertions (negative)" "ok" "${R2_RESTIC_ASSERTION_EXPR}"
nix_eval_expect "home-manager r2-cloud wrapper (positive)" "ok" "${HM_R2_CLI_POSITIVE_EXPR}"
nix_eval_expect "home-manager rclone config (positive)" "ok" "${HM_RCLONE_CONFIG_POSITIVE_EXPR}"
nix_eval_expect_failure \
  "home-manager r2-cloud assertions (negative)" \
  "programs.r2-cloud.accountId must be set when programs.r2-cloud.enable = true" \
  "${HM_R2_CLI_ASSERTION_EXPR}"
nix_eval_expect_failure \
  "home-manager credentials assertions (negative)" \
  "programs.r2-cloud.credentials.accessKeyIdFile must be set when programs.r2-cloud.credentials.manage = true" \
  "${HM_R2_CREDENTIALS_ASSERTION_EXPR}"
