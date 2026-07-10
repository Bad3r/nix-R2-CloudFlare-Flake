#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/codex-mcp-login-all.sh [--config <path>] [--include-command-servers] [--dry-run]

Runs `codex mcp login <server>` for each URL-backed MCP server configured in
.codex/config.toml, one server at a time, in config order. Servers that report
no authorization support are skipped.

Options:
  --config <path>              Read MCP servers from a different TOML file.
  --include-command-servers    Include command-only MCP servers too.
  --all                        Alias for --include-command-servers.
  --dry-run                    Print commands without running them.
  -h, --help                   Show this help.
USAGE
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

require_command() {
  local name="$1"
  if ! command -v "${name}" >/dev/null 2>&1; then
    fail "required command is not available in PATH: ${name}"
  fi
}

tmp_login_output=""

cleanup_login_output() {
  if [[ -n ${tmp_login_output} ]]; then
    rm -f "${tmp_login_output}"
    tmp_login_output=""
  fi
}

# Remove an in-flight login capture if the run is interrupted mid-login; the
# normal paths in login_server clean up between servers themselves. INT, TERM,
# and HUP convert to an exit so the EXIT trap fires with the signal's status.
trap cleanup_login_output EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

login_server() {
  local server="$1"
  local status tee_status
  local -a pipe_statuses

  tmp_login_output="$(mktemp "${TMPDIR:-/tmp}/codex-mcp-login.XXXXXX")"

  set +e
  codex mcp login "${server}" 2>&1 | tee "${tmp_login_output}"
  pipe_statuses=("${PIPESTATUS[@]}")
  set -e

  status="${pipe_statuses[0]}"
  tee_status="${pipe_statuses[1]}"

  if [[ ${tee_status} -ne 0 ]]; then
    cleanup_login_output
    fail "failed to capture login output for ${server}"
  fi

  if [[ ${status} -eq 0 ]]; then
    cleanup_login_output
    return 0
  fi

  if grep -Fq "No authorization support detected" "${tmp_login_output}"; then
    echo "==> skipping ${server}: no authorization support detected"
    cleanup_login_output
    return 0
  fi

  cleanup_login_output
  return "${status}"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "${script_dir}/.." && pwd -P)"
config_path="${repo_root}/.codex/config.toml"
include_command_servers=0
dry_run=0

while [[ $# -gt 0 ]]; do
  case "$1" in
  --config)
    [[ $# -ge 2 ]] || fail "--config requires a path"
    config_path="$2"
    shift 2
    ;;
  --include-command-servers | --all)
    include_command_servers=1
    shift
    ;;
  --dry-run)
    dry_run=1
    shift
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    fail "unknown argument: $1"
    ;;
  esac
done

[[ -f ${config_path} ]] || fail "config file not found: ${config_path}"

require_command "taplo"
require_command "jq"
if [[ ${dry_run} -eq 0 ]]; then
  require_command "codex"
fi

# Capture taplo|jq output first so a parse failure (invalid TOML or a missing
# mcp_servers table) surfaces as a real error instead of an empty list that
# reads as "no servers found". pipefail makes the assignment inherit the first
# failing command's status.
server_keys="$(
  taplo get -f "${config_path}" -o json mcp_servers |
    jq -r --arg include_command_servers "${include_command_servers}" '
      to_entries[]
      | select(
          $include_command_servers == "1"
          or ((.value.url? // "") | length > 0)
        )
      | .key
    '
)" || fail "failed to read MCP servers from ${config_path} (invalid TOML or missing mcp_servers table)"

servers=()
if [[ -n ${server_keys} ]]; then
  mapfile -t servers <<<"${server_keys}"
fi

if [[ ${#servers[@]} -eq 0 ]]; then
  if [[ ${include_command_servers} -eq 0 ]]; then
    fail "no URL-backed MCP servers found in ${config_path}"
  fi
  fail "no MCP servers found in ${config_path}"
fi

for server in "${servers[@]}"; do
  echo "==> codex mcp login ${server}"
  if [[ ${dry_run} -eq 0 ]]; then
    login_server "${server}"
  fi
done
