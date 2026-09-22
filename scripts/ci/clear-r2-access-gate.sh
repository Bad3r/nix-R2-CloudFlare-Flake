#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/ci/lib.sh
source "${SCRIPT_DIR}/lib.sh"

usage() {
  cat <<'USAGE'
Usage:
  clear-r2-access-gate.sh --dry-run <host-or-base-url>
  clear-r2-access-gate.sh --yes <host-or-base-url>

Arguments:
  host-or-base-url    Host (files.unsigned.sh) or absolute URL (https://files.unsigned.sh).

Flags (exactly one required):
  --dry-run    List stale Access apps that would be deleted. Deletes nothing.
  --yes        Perform the deletion. Run with --dry-run first and review the
               list; there is no other confirmation prompt before deletion.

Behavior:
  Deletes stale Cloudflare Access apps that gate the R2 Explorer API/share domains:
  - <host>/api/v2/*
  - <host>/share/*
  - <host>/api/v2/share/*
  - <host>/api/share/*

Required environment:
  CLOUDFLARE_API_TOKEN
  CLOUDFLARE_ACCOUNT_ID
USAGE
}

normalize_host() {
  local raw="$1"
  local stripped
  stripped="$(
    printf '%s' "${raw}" |
      sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##; s#/.*$##; s#:[0-9]+$##' |
      tr '[:upper:]' '[:lower:]'
  )"
  if [[ -z ${stripped} ]]; then
    fail "could not derive host from '${raw}'"
  fi
  printf '%s\n' "${stripped}"
}

cf_api_delete() {
  local path="$1"
  local response_file http_code

  response_file="$(mktemp "${TMPDIR:-/tmp}/cf-api-delete.XXXXXX.json")"
  if ! http_code="$(
    curl -sS \
      --max-time "${CF_API_TIMEOUT_SEC}" \
      --connect-timeout "${CF_API_CONNECT_TIMEOUT_SEC}" \
      -X DELETE \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      --output "${response_file}" \
      --write-out '%{http_code}' \
      "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}${path}"
  )"; then
    rm -f "${response_file}"
    fail "Cloudflare API request did not complete (DELETE ${path}, limit ${CF_API_TIMEOUT_SEC}s); see the curl error above"
  fi

  if [[ ! ${http_code} =~ ^[0-9]{3}$ ]]; then
    rm -f "${response_file}"
    fail "unexpected HTTP status while calling ${path}: ${http_code}"
  fi

  if ((http_code >= 400)); then
    echo "Cloudflare API error (DELETE ${path}, HTTP ${http_code}):" >&2
    if jq -e . "${response_file}" >/dev/null 2>&1; then
      jq -r '.errors // .' "${response_file}" >&2
    else
      cat "${response_file}" >&2
    fi
    rm -f "${response_file}"
    fail "Cloudflare API request failed"
  fi

  cat "${response_file}"
  rm -f "${response_file}"
}

dry_run="false"
confirmed="false"
positional_args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
  -h | --help)
    usage
    exit 0
    ;;
  --dry-run)
    dry_run="true"
    shift
    ;;
  --yes)
    confirmed="true"
    shift
    ;;
  -*)
    usage >&2
    fail "unknown flag: $1"
    ;;
  *)
    positional_args+=("$1")
    shift
    ;;
  esac
done

if [[ ${#positional_args[@]} -ne 1 ]]; then
  usage >&2
  fail "expected 1 argument, got ${#positional_args[@]}"
fi

if [[ ${dry_run} == "true" && ${confirmed} == "true" ]]; then
  usage >&2
  fail "--dry-run and --yes are mutually exclusive"
fi

if [[ ${dry_run} != "true" && ${confirmed} != "true" ]]; then
  usage >&2
  fail "real deletion requires --yes; pass --dry-run to preview matches first"
fi

require_command "curl"
require_command "jq"
require_env "CLOUDFLARE_API_TOKEN"
require_env "CLOUDFLARE_ACCOUNT_ID"

host="$(normalize_host "${positional_args[0]}")"
domains_json="$(
  jq -cn --arg host "${host}" '
    [
      "\($host)/api/v2/*",
      "\($host)/share/*",
      "\($host)/api/v2/share/*",
      "\($host)/api/share/*"
    ]'
)"

apps_results_json="$(cf_api_get_paginated_results "/access/apps" "Access apps")"
stale_apps_json="$(
  jq -c --argjson domains "${domains_json}" '
    [
      .[]
      | select(.domain as $domain | any($domains[]; . == $domain))
      | {
          id: .id,
          name: (.name // ""),
          domain: (.domain // ""),
          aud: (.aud // "")
        }
    ]' <<<"${apps_results_json}"
)"

stale_count="$(jq -r 'length' <<<"${stale_apps_json}")"
if [[ ${stale_count} == "0" ]]; then
  echo "No stale Access API/share apps found for ${host}"
  exit 0
fi

if [[ ${dry_run} == "true" ]]; then
  echo "Dry run: ${stale_count} stale Access app(s) for ${host} would be removed:"
else
  echo "Removing ${stale_count} stale Access app(s) for ${host}:"
fi
jq -r '.[] | "- id=\(.id) domain=\(.domain) name=\(.name) aud=\(.aud)"' <<<"${stale_apps_json}"

if [[ ${dry_run} == "true" ]]; then
  echo "Dry run: no changes made. Re-run with --yes to delete the app(s) listed above."
  exit 0
fi

while IFS= read -r app_id; do
  [[ -n ${app_id} ]] || continue
  delete_response="$(cf_api_delete "/access/apps/${app_id}")"
  delete_success="$(jq -r '.success' <<<"${delete_response}")"
  if [[ ${delete_success} != "true" ]]; then
    fail "failed deleting Access app ${app_id}: $(jq -c '.errors // []' <<<"${delete_response}")"
  fi
done < <(jq -r '.[].id' <<<"${stale_apps_json}")

echo "Stale Access gate cleanup complete for ${host}"
