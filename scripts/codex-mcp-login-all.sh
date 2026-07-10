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

login_server() {
  local server="$1"
  local output_file status tee_status
  local -a pipe_statuses

  output_file="$(mktemp "${TMPDIR:-/tmp}/codex-mcp-login.XXXXXX")"

  set +e
  codex mcp login "${server}" 2>&1 | tee "${output_file}"
  pipe_statuses=("${PIPESTATUS[@]}")
  set -e

  status="${pipe_statuses[0]}"
  tee_status="${pipe_statuses[1]}"

  if [[ ${tee_status} -ne 0 ]]; then
    rm -f "${output_file}"
    fail "failed to capture login output for ${server}"
  fi

  if [[ ${status} -eq 0 ]]; then
    rm -f "${output_file}"
    return 0
  fi

  if grep -Fq "No authorization support detected" "${output_file}"; then
    echo "==> skipping ${server}: no authorization support detected"
    rm -f "${output_file}"
    return 0
  fi

  rm -f "${output_file}"
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

mapfile -t servers < <(
  taplo get -f "${config_path}" -o json mcp_servers |
    jq -r --arg include_command_servers "${include_command_servers}" '
      to_entries[]
      | select(
          $include_command_servers == "1"
          or ((.value.url? // "") | length > 0)
        )
      | .key
    '
)

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
