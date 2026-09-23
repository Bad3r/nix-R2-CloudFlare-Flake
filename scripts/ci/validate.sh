#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

# Module evals and template checks resolve the flake under test through this
# ref instead of a bare path, so Nix's git-aware fetcher, not the unfiltered
# `path:` fetcher, decides what leaves the working tree: tracked files plus
# `git add`ed pending changes, never .env, node_modules, or .git (a new file
# is invisible until `git add`ed, the normal flake rule). Override this in a
# linked Lix worktree, where `.git` is a file, not a directory, and a clean
# worktree cannot be fetched as `git+file`.
# `shallow=1` because CI checks out with fetch-depth 1: Nix refuses to lock a
# shallow repository without it (no revCount) and Lix refuses to fetch one at
# all. Nothing here reads revCount; lib/version.nix stamps from shortRev.
NIX_VALIDATE_FLAKE_REF="${NIX_VALIDATE_FLAKE_REF:-git+file://${REPO_ROOT}?shallow=1}"
export NIX_VALIDATE_FLAKE_REF

CACHE_URL_DEFAULT="https://cache.nixos.org"
CACHE_URL="${NIX_VALIDATE_CACHE_URL:-${CACHE_URL_DEFAULT}}"
CACHE_INFO_URL="${CACHE_URL%/}/nix-cache-info"
PROJECT_CACHE_URL="https://nix-r2-cloudflare-flake.cachix.org/"
WRANGLER_CACHE_URL="https://wrangler.cachix.org/"
CACHE_NIXOS_KEY="cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
PROJECT_CACHE_KEY="nix-r2-cloudflare-flake.cachix.org-1:pmYucG85iBm6Y+8TxNwqU5j/lmY1UBReZxIXslMFntw="
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
  SUBSTITUTERS_LINE="substituters = ${CACHE_URL%/}/ ${PROJECT_CACHE_URL} ${WRANGLER_CACHE_URL}"
else
  echo "Warning: ${CACHE_INFO_URL} is unreachable. Using ${PROJECT_CACHE_URL} and ${WRANGLER_CACHE_URL} only." >&2
  echo "Set NIX_VALIDATE_SUBSTITUTERS to override default substituters for this run." >&2
  SUBSTITUTERS_LINE="substituters = ${PROJECT_CACHE_URL} ${WRANGLER_CACHE_URL}"
fi

PINNED_NIX_CONFIG="accept-flake-config = true"$'\n'"${SUBSTITUTERS_LINE}"$'\n'"extra-substituters ="$'\n'"trusted-public-keys = ${CACHE_NIXOS_KEY} ${PROJECT_CACHE_KEY} ${WRANGLER_CACHE_KEY}"$'\n'"extra-trusted-public-keys ="$'\n'"http-connections = 50"$'\n'"${CACHE_TUNING}"

if [[ -n ${NIX_CONFIG:-} ]]; then
  export NIX_CONFIG="${NIX_CONFIG}"$'\n'"${PINNED_NIX_CONFIG}"
else
  export NIX_CONFIG="${PINNED_NIX_CONFIG}"
fi

run() {
  echo "+ $*"
  "$@"
}

# One EXIT trap for every temp dir: a per-function `trap ... RETURN` does not
# fire when `set -e` aborts the function or a signal arrives.
CLEANUP_DIRS=()

register_cleanup_dir() {
  CLEANUP_DIRS+=("$1")
}

cleanup_registered_dirs() {
  local dir
  if [[ ${#CLEANUP_DIRS[@]} -eq 0 ]]; then
    return 0
  fi
  for dir in "${CLEANUP_DIRS[@]}"; do
    rm -rf "${dir}"
  done
}
trap cleanup_registered_dirs EXIT
# Without an explicit exit, bash resumes the script after an INT/TERM handler.
trap 'exit 130' INT
trap 'exit 143' TERM

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

  # Both backends must scan the same set: README.md plus docs/** recursively,
  # excluding plan docs (docs/plan.md, docs/plan-*.md, docs/plan/**), matching
  # the AGENTS.md stale-phase policy. The rg branch previously used
  # --glob "docs/*.md", which silently skipped docs/operators and
  # docs/reference while the grep branch scanned them.
  #
  # flake.nix and r2-explorer/flake.nix carry their own user-visible
  # `description`, so they need the same scan; grep's --include "*.md" would
  # silently drop them even when named explicitly (unlike rg's --glob, which
  # only filters directory traversal), so they run through a second,
  # unfiltered call on both backends rather than joining the docs glob.
  scan_stale_phase_language() {
    local output_file="$1"
    : >"${output_file}"
    set +e
    case "${search_backend}" in
    rg)
      rg -n --glob "*.md" --glob "!plan.md" --glob "!plan-*.md" --glob "!**/plan/**" \
        "Phase[[:space:]]+[0-9]+" README.md docs >>"${output_file}"
      rg -n "Phase[[:space:]]+[0-9]+" flake.nix r2-explorer/flake.nix >>"${output_file}"
      ;;
    grep)
      grep -R --line-number --extended-regexp --include "README.md" \
        --include "*.md" --exclude "plan.md" --exclude "plan-*.md" --exclude-dir "plan" "Phase[[:space:]]+[0-9]+" \
        README.md docs >>"${output_file}"
      grep --line-number --extended-regexp "Phase[[:space:]]+[0-9]+" flake.nix r2-explorer/flake.nix >>"${output_file}"
      ;;
    *)
      set -e
      echo "Unsupported docs search backend: ${search_backend}" >&2
      exit 1
      ;;
    esac
    set -e
    [[ -s ${output_file} ]]
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
    echo "Stale phase language detected outside planning docs. Remove/update the following references:" >&2
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
  register_cleanup_dir "${temp_checkout}"

  # Snapshot only git-visible files (tracked plus untracked-but-not-ignored),
  # so .env, .git, and node_modules never reach the temp dir. A tracked file
  # deleted from the working tree is skipped instead of failing tar. git
  # ls-files lists a submodule or a nested repository as one directory entry
  # that tar would archive whole, unfiltered; those are skipped with a note.
  run mkdir -p "${temp_checkout}/repo"
  git ls-files -z --cached --others --exclude-standard |
    while IFS= read -r -d '' snapshot_file; do
      if [[ -d ${snapshot_file} && ! -L ${snapshot_file} ]]; then
        echo "Skipping nested repository or submodule from the validation snapshot: ${snapshot_file}" >&2
      elif [[ -e ${snapshot_file} || -L ${snapshot_file} ]]; then
        printf '%s\0' "${snapshot_file}"
      fi
    done |
    tar --null -T - -cf - |
    tar -xf - -C "${temp_checkout}/repo"

  (
    cd "${temp_checkout}/repo"
    # lefthook needs a git repo with a HEAD to resolve --all-files. No
    # auto-fixing `nix fmt` runs first: the formatting job must fail on drift.
    git init -q
    git config user.email "r2-cloud-validate@invalid"
    git config user.name "r2-cloud-validate"
    git add -A
    git commit -q -m "r2-cloud-validate snapshot" --no-gpg-sign
    run nix develop .#hooks --command lefthook run pre-commit --all-files
  )
}

run_template_checks() {
  local temp_root minimal_dir full_dir source_flake

  temp_root="$(mktemp -d "${TMPDIR:-/tmp}/r2-cloud-template-check.XXXXXX")"
  register_cleanup_dir "${temp_root}"
  minimal_dir="${temp_root}/minimal"
  full_dir="${temp_root}/full"
  # git+file (not path:) so only tracked/git-added content is fetched; see
  # NIX_VALIDATE_FLAKE_REF above.
  source_flake="${NIX_VALIDATE_FLAKE_REF}"

  run mkdir -p "${minimal_dir}" "${full_dir}"

  (
    cd "${minimal_dir}"
    run nix flake init -t "${source_flake}#minimal"
    run nix flake lock --override-input r2-cloud "${source_flake}"
    run nix flake check
  )

  (
    cd "${full_dir}"
    run nix flake init -t "${source_flake}#full"
    run nix flake lock --override-input r2-cloud "${source_flake}"
    run nix flake check
  )
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
  flake = builtins.getFlake (builtins.getEnv "NIX_VALIDATE_FLAKE_REF");
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
  flake = builtins.getFlake (builtins.getEnv "NIX_VALIDATE_FLAKE_REF");
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
  flake = builtins.getFlake (builtins.getEnv "NIX_VALIDATE_FLAKE_REF");
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

R2_SYNC_COMPARE_ASSERTION_EXPR="$(
  cat <<'NIX'
let
  flake = builtins.getFlake (builtins.getEnv "NIX_VALIDATE_FLAKE_REF");
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
            remotePrefix = "documents";
            mountPoint = "/mnt/r2/documents";
            bisync.compare = "size,mtime";
          };
        };
      }
    ];
  };
  failed = builtins.filter (a: !(a.assertion)) systemEval.config.assertions;
  expected = "services.r2-sync.mounts.documents.bisync.compare must be a comma-separated list of size, modtime, or checksum (rclone bisync --compare; null omits the flag): got 'size,mtime'";
in
if builtins.any (a: a.message == expected) failed then "ok" else builtins.throw "Missing expected r2-sync bisync.compare assertion"
NIX
)"

R2_RESTIC_ASSERTION_EXPR="$(
  cat <<'NIX'
let
  flake = builtins.getFlake (builtins.getEnv "NIX_VALIDATE_FLAKE_REF");
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
  flake = builtins.getFlake (builtins.getEnv "NIX_VALIDATE_FLAKE_REF");
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
  hasR2 =
    builtins.any (
      name:
      name == "r2" || (builtins.match "^r2-wrapper-[0-9].*$" name != null)
    ) packageNames;
in
if hasR2 then "ok" else builtins.throw "Missing expected r2 CLI wrapper in home.packages"
NIX
)"

HM_RCLONE_CONFIG_POSITIVE_EXPR="$(
  cat <<'NIX'
let
  flake = builtins.getFlake (builtins.getEnv "NIX_VALIDATE_FLAKE_REF");
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
if
  lib.hasInfix "endpoint = https://abc123.r2.cloudflarestorage.com" configText
  && lib.hasInfix "no_check_bucket = true" configText
then
  "ok"
else
  builtins.throw "Generated rclone.conf lacks the expected endpoint or no_check_bucket = true"
NIX
)"

HM_R2_CLI_ASSERTION_EXPR="$(
  cat <<'NIX'
let
  flake = builtins.getFlake (builtins.getEnv "NIX_VALIDATE_FLAKE_REF");
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
  flake = builtins.getFlake (builtins.getEnv "NIX_VALIDATE_FLAKE_REF");
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
  flake = builtins.getFlake (builtins.getEnv "NIX_VALIDATE_FLAKE_REF");
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
  flake = builtins.getFlake (builtins.getEnv "NIX_VALIDATE_FLAKE_REF");
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

# One eval for every r2-sync assertion scenario plus the generated unit shape:
# each NixOS evaluation costs seconds, so the cases share a single process.
R2_SYNC_ASSERTION_MATRIX_EXPR="$(
  cat <<'NIX'
let
  flake = builtins.getFlake (builtins.getEnv "NIX_VALIDATE_FLAKE_REF");
  lib = flake.inputs.nixpkgs.lib;
  evalMounts =
    extra: mounts:
    (lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        { system.stateVersion = "25.05"; }
        flake.outputs.nixosModules.r2-sync
        {
          services.r2-sync = {
            enable = true;
            accountId = "abc123";
            credentialsFile = "/run/secrets/r2";
            inherit mounts;
          };
        }
        extra
      ];
    }).config;
  mount =
    attrs:
    {
      bucket = "files";
      remotePrefix = "documents";
      mountPoint = "/mnt/r2/documents";
      localPath = "/data/r2/documents";
    }
    // attrs;
  pair = b: {
    a = mount {
      mountPoint = "/mnt/r2/a";
      localPath = "/data/r2/a";
    };
    b = mount (
      {
        mountPoint = "/mnt/r2/b";
        localPath = "/data/r2/b";
      }
      // b
    );
  };
  scenarios = [
    {
      name = "mount name";
      mounts."odd name" = mount { };
      expect = "is not a valid mount name";
    }
    {
      name = "mount name .";
      mounts."." = mount { };
      expect = "is not a valid mount name";
    }
    {
      name = "mount name ..";
      mounts.".." = mount { };
      expect = "is not a valid mount name";
    }
    {
      name = "localPath unset";
      mounts.documents = builtins.removeAttrs (mount { }) [ "localPath" ];
      expect = "must not equal or be nested with mountPoint";
    }
    {
      name = "localPath equals mountPoint";
      mounts.documents = mount { localPath = "/mnt/r2/documents"; };
      expect = "must not equal or be nested with mountPoint";
    }
    {
      name = "mountPoint nested in localPath";
      mounts.documents = mount { mountPoint = "/data/r2/documents/mnt"; };
      expect = "must not equal or be nested with mountPoint";
    }
    {
      name = "filter flag in extraArgs";
      mounts.documents = mount { bisync.extraArgs = [ "--exclude=*.tmp" ]; };
      expect = "bisync.extraArgs must not contain filter flags";
    }
    {
      name = "-f=X filter flag in extraArgs";
      mounts.documents = mount { bisync.extraArgs = [ "-f=- *.tmp" ]; };
      expect = "bisync.extraArgs must not contain filter flags";
    }
    {
      name = "-fX filter flag in extraArgs";
      mounts.documents = mount { bisync.extraArgs = [ "-f- *.tmp" ]; };
      expect = "bisync.extraArgs must not contain filter flags";
    }
    {
      name = "-f in a shorthand cluster in extraArgs";
      mounts.documents = mount {
        bisync.extraArgs = [
          "-vf"
          "- *.tmp"
        ];
      };
      expect = "bisync.extraArgs must not contain filter flags";
    }
    {
      name = "-f after bisync's -1 shorthand in extraArgs";
      mounts.documents = mount {
        bisync.extraArgs = [
          "-1f"
          "- *.tmp"
        ];
      };
      expect = "bisync.extraArgs must not contain filter flags";
    }
    {
      name = "metadata rules file in extraArgs";
      mounts.documents = mount { bisync.extraArgs = [ "--metadata-include-from=/etc/r2/metadata-rules" ]; };
      expect = "bisync.extraArgs must not contain filter flags";
    }
    {
      name = "--files-from0 in extraArgs";
      mounts.documents = mount { bisync.extraArgs = [ "--files-from0=/etc/r2/files" ]; };
      expect = "bisync.extraArgs must not contain filter flags";
    }
    {
      name = "--delete-excluded in extraArgs";
      mounts.documents = mount { bisync.extraArgs = [ "--delete-excluded" ]; };
      expect = "bisync.extraArgs must not contain --delete-excluded";
    }
    {
      name = "unparsable bisync.timeout";
      mounts.documents = mount { bisync.timeout = "24hrs"; };
      expect = "bisync.timeout must be '' (no limit) or a systemd.time(7) time span";
    }
    {
      name = "unparsable syncInterval";
      mounts.documents = mount { syncInterval = "5mins"; };
      expect = "syncInterval must be a systemd.time(7) time span";
    }
    {
      name = "same remote tree";
      mounts = pair { };
      expect = "both target bucket";
    }
    {
      name = "nested remote prefixes";
      mounts = pair { remotePrefix = "documents/sub"; };
      expect = "have nested remote prefixes in the same bucket";
    }
    {
      name = "overlapping local paths";
      mounts = pair {
        remotePrefix = "photos";
        localPath = "/data/r2/a/sub";
      };
      expect = "overlap: each mount must use independent mountPoint and localPath directories";
    }
    {
      name = "non-root mount user without user_allow_other";
      extra.systemd.services."r2-mount-documents".serviceConfig.User = "alice";
      mounts.documents = mount { };
      expect = "without programs.fuse.userAllowOther = true";
    }
  ];
  failedMessages = config: map (a: a.message) (builtins.filter (a: !a.assertion) config.assertions);
  missing = builtins.filter (
    s:
    !(builtins.any (lib.hasInfix s.expect) (failedMessages (evalMounts (s.extra or { }) s.mounts)))
  ) scenarios;

  # The extraArgs hold an f in a long flag, a switch cluster without f, and an
  # f after "=", none of which is the -f filter shorthand, then two listing
  # filters that must be tracked with their values, an untracked flag the
  # --ignore-case switch must not record as its value, and a --metadata-filter
  # rule whose f follows a space, where pflag stops before reading -f. Mount b
  # also lifts the run deadline and syncs on a two-term time span, while mount
  # a keeps the defaults.
  valid = evalMounts { } (pair {
    remotePrefix = "photos";
    syncInterval = "1h 30min";
    bisync = {
      extraArgs = [
        "--fast-list"
        "-vP"
        "--suffix=-offsite"
        "--max-age"
        "30d"
        "--ignore-case"
        "--checkers"
        "4"
        "--metadata-filter"
        "- fowner=1000"
      ];
      timeout = "";
    };
  });
  validFailures = builtins.filter (lib.hasInfix "services.r2-sync") (failedMessages valid);
  bisyncService = valid.systemd.services."r2-bisync-a".serviceConfig;
  bisyncScript = builtins.readFile bisyncService.ExecStart;
  mountScript = builtins.readFile valid.systemd.services."r2-mount-a".serviceConfig.ExecStart;
  trackingScript = builtins.readFile valid.systemd.services."r2-bisync-b".serviceConfig.ExecStart;
  shapeProblems =
    lib.optional (!(lib.hasInfix "--max-delete=50" bisyncScript)) "bisync script lacks the default --max-delete=50"
    ++ lib.optional (!(lib.hasInfix "--s3-no-check-bucket" bisyncScript)) "bisync script lacks --s3-no-check-bucket"
    ++ lib.optional (!(lib.hasInfix "--s3-no-check-bucket" mountScript)) "mount script lacks --s3-no-check-bucket"
    ++ lib.optional (
      !(lib.hasInfix "\ncurrent_flags='--max-age\n30d\n--ignore-case\n--metadata-filter\n- fowner=1000'\n" trackingScript)
    ) "bisync script does not track exactly the listing filters in extraArgs"
    ++ lib.optional (bisyncService.TimeoutStartSec or null != "24h") "bisync service lacks the default TimeoutStartSec=24h"
    ++ lib.optional (
      valid.systemd.services."r2-bisync-b".serviceConfig.TimeoutStartSec or null != "infinity"
    ) "bisync.timeout = \"\" does not give TimeoutStartSec=infinity"
    ++ lib.optional (
      !(valid.systemd.timers."r2-bisync-a".timerConfig ? RandomizedDelaySec)
    ) "bisync timer lacks RandomizedDelaySec";

  problems =
    map (s: "assertion not raised: ${s.name}") missing
    ++ map (m: "valid two-mount config failed: ${m}") validFailures
    ++ shapeProblems;
in
if problems == [ ] then "ok" else builtins.throw (lib.concatStringsSep "; " problems)
NIX
)"

R2_SYNC_MAX_DELETE_RANGE_EXPR="$(
  cat <<'NIX'
let
  flake = builtins.getFlake (builtins.getEnv "NIX_VALIDATE_FLAKE_REF");
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
            bucket = "files";
            remotePrefix = "documents";
            mountPoint = "/mnt/r2/documents";
            localPath = "/data/r2/documents";
            bisync.maxDelete = 100000;
          };
        };
      }
    ];
  };
in
systemEval.config.systemd.services."r2-bisync-documents".serviceConfig.ExecStart
NIX
)"

R2_RESTIC_SCRIPT_EXPR="$(
  cat <<'NIX'
let
  flake = builtins.getFlake (builtins.getEnv "NIX_VALIDATE_FLAKE_REF");
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
  service = systemEval.config.systemd.services.r2-restic-backup.serviceConfig;
  script = builtins.readFile service.ExecStart;
  beforeForget = builtins.head (lib.splitString "restic forget" script);
  problems =
    lib.optional (!(lib.hasInfix "backup_status=$?" script)) "backup exit status is not captured"
    ++ lib.optional (!(lib.hasInfix "restic unlock" beforeForget)) "restic unlock does not run before forget"
    ++ lib.optional (service.CacheDirectory or null != "r2-restic-backup") "CacheDirectory is not set";
in
if problems == [ ] then "ok" else builtins.throw (lib.concatStringsSep "; " problems)
NIX
)"

HM_RCLONE_COLLISION_ASSERTION_EXPR="$(
  cat <<'NIX'
let
  flake = builtins.getFlake (builtins.getEnv "NIX_VALIDATE_FLAKE_REF");
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
        programs.rclone.enable = true;
      }
    ];
  };
in
hmEval.activationPackage.name
NIX
)"

HM_REMOTE_NAME_ASSERTION_EXPR="$(
  cat <<'NIX'
let
  flake = builtins.getFlake (builtins.getEnv "NIX_VALIDATE_FLAKE_REF");
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
          accountIdFile = "/run/secrets/r2/account-id";
          rcloneRemoteName = "my-remote";
        };
      }
    ];
  };
in
hmEval.activationPackage.name
NIX
)"

# Runs a command that must fail and print the expected text.
expect_failure_output() {
  local label="$1"
  local expected_substring="$2"
  shift 2
  local output exit_code

  echo "+ (expected failure: ${label})"
  set +e
  output="$("$@" 2>&1)"
  exit_code=$?
  set -e

  if [[ ${exit_code} -eq 0 ]]; then
    echo "Expected failure for ${label}, but the command succeeded." >&2
    exit 1
  fi
  if [[ ${output} != *"${expected_substring}"* ]]; then
    echo "${label} failed, but not with the expected message." >&2
    echo "Expected to find: ${expected_substring}" >&2
    echo "Actual output:" >&2
    echo "${output}" >&2
    exit 1
  fi
}

# Hermetic CLI checks: isolated HOME, fake credential files, no network.
run_cli_behavior_checks() {
  local r2_bin cli_home expected_version actual_version

  r2_bin="$(nix build .#r2 --no-link --print-out-paths)/bin/r2"
  cli_home="$(mktemp -d "${TMPDIR:-/tmp}/r2-cloud-cli-check.XXXXXX")"
  register_cleanup_dir "${cli_home}"

  expected_version="$(nix eval --raw .#r2.version)"
  echo "+ r2 version"
  actual_version="$(HOME="${cli_home}" "${r2_bin}" version)"
  if [[ ${actual_version} != "${expected_version}" ]]; then
    echo "r2 version printed '${actual_version}', expected '${expected_version}'." >&2
    exit 1
  fi

  expect_failure_output "r2 bucket lifecycle add with an empty prefix" "prefix is required" \
    env HOME="${cli_home}" "${r2_bin}" bucket lifecycle add bucket rule "" --expire-days 7

  printf 'R2_ACCOUNT_ID=abc123\nthis line is not an assignment\n' >"${cli_home}/malformed.env"
  expect_failure_output "r2 with a malformed credentials file" "line 2: expected KEY=VALUE" \
    env HOME="${cli_home}" R2_CREDENTIALS_FILE="${cli_home}/malformed.env" "${r2_bin}" bucket list
}

run_target_root_format_lint() {
  run_quality_checks_in_temp_checkout
}

run_target_root_flake_template_docs() {
  run nix flake check
  run_template_checks
  run_docs_checks
  # Scan .github (workflows and composite actions) so the Nix installer
  # hardening invariant follows the shared setup-nix-cachix action.
  if command -v rg >/dev/null 2>&1; then
    if rg -n "require-sigs = false" .github >/dev/null; then
      echo "Workflow hardening check failed: found 'require-sigs = false' in .github." >&2
      rg -n "require-sigs = false" .github >&2
      exit 1
    fi
  elif grep -R --line-number "require-sigs = false" .github >/dev/null; then
    echo "Workflow hardening check failed: found 'require-sigs = false' in .github." >&2
    grep -R --line-number "require-sigs = false" .github >&2
    exit 1
  fi
}

run_target_root_cli_module_eval() {
  run nix build .#r2
  run nix run .#r2 -- help
  run nix run .#r2 -- bucket help
  run nix run .#r2 -- bucket lifecycle help
  run nix run .#r2 -- share help
  run nix run .#r2 -- share worker help
  nix_eval_expect "r2-sync module (positive)" "R2 FUSE mount for documents" "${R2_SYNC_POSITIVE_EXPR}"
  nix_eval_expect "r2-restic module (positive)" "Restic backup timer" "${R2_RESTIC_POSITIVE_EXPR}"
  nix_eval_expect "r2-sync assertions (negative)" "ok" "${R2_SYNC_ASSERTION_EXPR}"
  nix_eval_expect "r2-sync bisync.compare assertion (negative)" "ok" "${R2_SYNC_COMPARE_ASSERTION_EXPR}"
  nix_eval_expect "r2-restic assertions (negative)" "ok" "${R2_RESTIC_ASSERTION_EXPR}"
  nix_eval_expect "git-annex module (positive)" "ok" "${GIT_ANNEX_POSITIVE_EXPR}"
  nix_eval_expect "git-annex assertions (negative)" "ok" "${GIT_ANNEX_ASSERTION_EXPR}"
  nix_eval_expect "home-manager r2-cloud wrapper (positive)" "ok" "${HM_R2_CLI_POSITIVE_EXPR}"
  nix_eval_expect "home-manager rclone config (positive)" "ok" "${HM_RCLONE_CONFIG_POSITIVE_EXPR}"
  nix_eval_expect_failure \
    "home-manager r2-cloud assertions (negative)" \
    "programs.r2-cloud.accountId or programs.r2-cloud.accountIdFile must be set when programs.r2-cloud.enable = true" \
    "${HM_R2_CLI_ASSERTION_EXPR}"
  nix_eval_expect_failure \
    "home-manager credentials assertions (negative)" \
    "programs.r2-cloud.credentials.accessKeyIdFile must be set when programs.r2-cloud.credentials.manage = true" \
    "${HM_R2_CREDENTIALS_ASSERTION_EXPR}"
  nix_eval_expect "r2-sync assertion matrix and unit shape" "ok" "${R2_SYNC_ASSERTION_MATRIX_EXPR}"
  nix_eval_expect_failure \
    "r2-sync bisync.maxDelete range (negative)" \
    "bisync.maxDelete" \
    "${R2_SYNC_MAX_DELETE_RANGE_EXPR}"
  nix_eval_expect "r2-restic backup script and cache directory" "ok" "${R2_RESTIC_SCRIPT_EXPR}"
  nix_eval_expect_failure \
    "home-manager rclone.conf collision with programs.rclone (negative)" \
    "programs.r2-cloud.enableRcloneRemote and programs.rclone.enable must not both manage the same rclone.conf" \
    "${HM_RCLONE_COLLISION_ASSERTION_EXPR}"
  nix_eval_expect_failure \
    "home-manager env-var-safe remote name (negative)" \
    "programs.r2-cloud.rcloneRemoteName must be env-var-safe" \
    "${HM_REMOTE_NAME_ASSERTION_EXPR}"
  run_cli_behavior_checks
}

run_target_worker_typecheck_test() {
  # test:all = node suite (test:api) + workerd pool (test:workers), so the
  # real Durable Objects are exercised in CI, not only the memory fakes.
  run nix develop ./r2-explorer --command bash -lc "cd r2-explorer && pnpm install --frozen-lockfile && pnpm run check && pnpm run build:web && pnpm run test:all"
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
