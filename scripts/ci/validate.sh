#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

CACHE_URL_DEFAULT="https://cache.nixos.org"
CACHE_URL="${NIX_VALIDATE_CACHE_URL:-${CACHE_URL_DEFAULT}}"
CACHE_INFO_URL="${CACHE_URL%/}/nix-cache-info"
WRANGLER_CACHE_URL="https://wrangler.cachix.org/"
CACHE_NIXOS_KEY="cache.nixos.org-1:6NCHdD59X431o0gWypbYQ2I6D8sfr8Y9f3l8S8d5N9Q="
WRANGLER_CACHE_KEY="wrangler.cachix.org-1:N/FIcG2qBQcolSpklb2IMDbsfjZKWg+ctxx0mSMXdSs="

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
  SUBSTITUTERS_LINE="substituters = ${CACHE_URL%/}/ ${WRANGLER_CACHE_URL}"
else
  echo "Warning: ${CACHE_INFO_URL} is unreachable. Using ${WRANGLER_CACHE_URL} only." >&2
  echo "Set NIX_VALIDATE_SUBSTITUTERS to override default substituters for this run." >&2
  SUBSTITUTERS_LINE="substituters = ${WRANGLER_CACHE_URL}"
fi

PINNED_NIX_CONFIG="${SUBSTITUTERS_LINE}"$'\n'"extra-substituters ="$'\n'"trusted-public-keys = ${CACHE_NIXOS_KEY} ${WRANGLER_CACHE_KEY}"$'\n'"extra-trusted-public-keys ="$'\n'"http-connections = 50"$'\n'"${CACHE_TUNING}"

if [[ -n ${NIX_CONFIG:-} ]]; then
  export NIX_CONFIG="${NIX_CONFIG}"$'\n'"${PINNED_NIX_CONFIG}"
else
  export NIX_CONFIG="${PINNED_NIX_CONFIG}"
fi

run() {
  echo "+ $*"
  "$@"
}

ALL_TARGETS=(
  "root-format-lint"
  "root-flake-template-docs"
  "root-cli-module-eval"
  "worker-typecheck-test"
)

print_usage() {
  cat <<'EOF'
Usage: ./scripts/ci/validate.sh [--target <name>]... [--list-targets]

Options:
  --target <name>   Run only the named validation target (repeatable).
  --list-targets    Print all available targets and exit.
  -h, --help        Show this help.

If no --target is provided, all targets are run in baseline CI order.
EOF
}

print_targets() {
  for target in "${ALL_TARGETS[@]}"; do
    echo "${target}"
  done
}

is_valid_target() {
  local candidate="$1"
  local target
  for target in "${ALL_TARGETS[@]}"; do
    if [[ ${target} == "${candidate}" ]]; then
      return 0
    fi
  done
  return 1
}

parse_args() {
  local arg
  SELECTED_TARGETS=()

  while [[ $# -gt 0 ]]; do
    arg="$1"
    case "${arg}" in
    --target)
      if [[ $# -lt 2 ]]; then
        echo "--target requires a value." >&2
        exit 1
      fi
      if [[ -z ${2} ]]; then
        echo "--target requires a non-empty value." >&2
        exit 1
      fi
      SELECTED_TARGETS+=("$2")
      shift 2
      ;;
    --list-targets)
      print_targets
      exit 0
      ;;
    -h | --help)
      print_usage
      exit 0
      ;;
    *)
      echo "Unknown argument: ${arg}" >&2
      print_usage >&2
      exit 1
      ;;
    esac
  done

  if [[ ${#SELECTED_TARGETS[@]} -eq 0 ]]; then
    SELECTED_TARGETS=("${ALL_TARGETS[@]}")
  fi

  for arg in "${SELECTED_TARGETS[@]}"; do
    if ! is_valid_target "${arg}"; then
      echo "Unknown validation target: ${arg}" >&2
      echo "Use --list-targets to see supported values." >&2
      exit 1
    fi
  done
}

run_docs_checks() {
  local stale_output
  local search_backend
  local check_file
  if command -v rg >/dev/null 2>&1; then
    search_backend="rg"
  else
    search_backend="grep"
  fi

  contains_pattern() {
    local pattern="$1"
    local file="$2"
    case "${search_backend}" in
    rg)
      rg -q "${pattern}" "${file}"
      ;;
    grep)
      grep -q "${pattern}" "${file}"
      ;;
    *)
      echo "Unsupported docs search backend: ${search_backend}" >&2
      exit 1
      ;;
    esac
  }

  scan_stale_phase_language() {
    local output_file="$1"
    case "${search_backend}" in
    rg)
      rg -n --glob "README.md" --glob "docs/*.md" --glob "!docs/plan.md" \
        "Phase[[:space:]]+[0-9]+" README.md docs >"${output_file}"
      ;;
    grep)
      grep -R --line-number --extended-regexp --include "README.md" \
        --include "*.md" --exclude "plan.md" "Phase[[:space:]]+[0-9]+" \
        README.md docs >"${output_file}"
      ;;
    *)
      echo "Unsupported docs search backend: ${search_backend}" >&2
      exit 1
      ;;
    esac
  }

  local required_reference_files=(
    "docs/reference/index.md"
    "docs/reference/services-r2-sync.md"
    "docs/reference/services-r2-restic.md"
    "docs/reference/programs-r2-cloud.md"
    "docs/reference/programs-r2-cloud-credentials.md"
    "docs/reference/programs-r2-cloud-rclone-config.md"
    "docs/reference/programs-git-annex-r2.md"
    "docs/operators/index.md"
    "docs/operators/key-rotation.md"
    "docs/operators/readonly-maintenance.md"
    "docs/operators/access-policy-split.md"
    "docs/operators/incident-response.md"
    "docs/operators/rollback-worker-share.md"
    "docs/operators/security-gates-remediation.md"
  )

  for file in "${required_reference_files[@]}"; do
    if [[ ! -f ${file} ]]; then
      echo "Missing required reference docs file: ${file}" >&2
      exit 1
    fi
  done

  stale_output="$(mktemp "${TMPDIR:-/tmp}/r2-cloud-doc-stale.XXXXXX")"
  if scan_stale_phase_language "${stale_output}"; then
    echo "Stale phase language detected outside docs/plan.md. Remove/update the following references:" >&2
    cat "${stale_output}" >&2
    rm -f "${stale_output}"
    exit 1
  fi
  rm -f "${stale_output}"

  for check_file in README.md docs/quickstart.md docs/credentials.md; do
    if ! contains_pattern "docs/reference/index.md" "${check_file}"; then
      echo "${check_file} must link to docs/reference/index.md." >&2
      exit 1
    fi
  done
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

run_template_checks() {
  local temp_root minimal_dir full_dir source_flake

  temp_root="$(mktemp -d "${TMPDIR:-/tmp}/r2-cloud-template-check.XXXXXX")"
  minimal_dir="${temp_root}/minimal"
  full_dir="${temp_root}/full"
  source_flake="path:${REPO_ROOT}"

  cleanup_template_checks() {
    rm -rf "${temp_root}"
  }

  trap cleanup_template_checks RETURN

  run mkdir -p "${minimal_dir}" "${full_dir}"

  (
    cd "${minimal_dir}"
    run nix flake init -t "${source_flake}#minimal"
    run nix flake check
  )

  (
    cd "${full_dir}"
    run nix flake init -t "${source_flake}#full"
    run nix flake check
  )

  cleanup_template_checks
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
  local exit_code

  echo "+ nix eval (expected failure: ${label})"
  set +e
  output="$(nix eval --impure --raw --expr "${expr}" 2>&1)"
  exit_code=$?
  set -e

  if [[ ${exit_code} -eq 0 ]]; then
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

GIT_ANNEX_POSITIVE_EXPR="$(
  cat <<'NIX'
let
  flake = builtins.getFlake (toString ./.);
  lib = flake.inputs.nixpkgs.lib;
  systemEval = lib.nixosSystem {
    system = "x86_64-linux";
    modules = [
      { system.stateVersion = "25.05"; }
      flake.outputs.nixosModules.git-annex
      {
        programs.git-annex-r2 = {
          enable = true;
          credentialsFile = "/run/secrets/r2";
          rcloneRemoteName = "r2";
        };
      }
    ];
  };
  packageNames = builtins.map (pkg: pkg.name) systemEval.config.environment.systemPackages;
  hasInitHelper = builtins.any (name: lib.hasPrefix "git-annex-r2-init" name) packageNames;
in
if hasInitHelper then "ok" else builtins.throw "Missing git-annex-r2-init package in environment.systemPackages"
NIX
)"

GIT_ANNEX_ASSERTION_EXPR="$(
  cat <<'NIX'
let
  flake = builtins.getFlake (toString ./.);
  lib = flake.inputs.nixpkgs.lib;
  systemEval = lib.nixosSystem {
    system = "x86_64-linux";
    modules = [
      { system.stateVersion = "25.05"; }
      flake.outputs.nixosModules.git-annex
      {
        programs.git-annex-r2 = {
          enable = true;
          credentialsFile = null;
        };
      }
    ];
  };
  failed = builtins.filter (a: !(a.assertion)) systemEval.config.assertions;
  expected = "programs.git-annex-r2.credentialsFile must be set when programs.git-annex-r2.enable = true";
in
if builtins.any (a: a.message == expected) failed then "ok" else builtins.throw "Missing expected git-annex assertion"
NIX
)"

run_target_root_format_lint() {
  run_quality_checks_in_temp_checkout
}

run_target_root_flake_template_docs() {
  run nix flake check
  run_template_checks
  run_docs_checks
}

run_target_root_cli_module_eval() {
  run nix build .#r2
  run nix run .#r2 -- help
  run nix run .#r2 -- bucket help
  run nix run .#r2 -- share help
  run nix run .#r2 -- share worker help
  nix_eval_expect "r2-sync module (positive)" "R2 FUSE mount for documents" "${R2_SYNC_POSITIVE_EXPR}"
  nix_eval_expect "r2-restic module (positive)" "Restic backup timer" "${R2_RESTIC_POSITIVE_EXPR}"
  nix_eval_expect "r2-sync assertions (negative)" "ok" "${R2_SYNC_ASSERTION_EXPR}"
  nix_eval_expect "r2-restic assertions (negative)" "ok" "${R2_RESTIC_ASSERTION_EXPR}"
  nix_eval_expect "git-annex module (positive)" "ok" "${GIT_ANNEX_POSITIVE_EXPR}"
  nix_eval_expect "git-annex assertions (negative)" "ok" "${GIT_ANNEX_ASSERTION_EXPR}"
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
}

run_target_worker_typecheck_test() {
  run nix develop ./r2-explorer --command bash -lc "cd r2-explorer && pnpm install --frozen-lockfile && pnpm run check && pnpm test"
}

run_target() {
  local target="$1"
  case "${target}" in
  root-format-lint)
    run_target_root_format_lint
    ;;
  root-flake-template-docs)
    run_target_root_flake_template_docs
    ;;
  root-cli-module-eval)
    run_target_root_cli_module_eval
    ;;
  worker-typecheck-test)
    run_target_worker_typecheck_test
    ;;
  *)
    echo "Unknown validation target: ${target}" >&2
    exit 1
    ;;
  esac
}

parse_args "$@"

for selected in "${SELECTED_TARGETS[@]}"; do
  run_target "${selected}"
done
