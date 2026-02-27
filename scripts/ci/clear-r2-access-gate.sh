#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Error: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:
  clear-r2-access-gate.sh <host-or-base-url>

Arguments:
  host-or-base-url    Host (files.unsigned.sh) or absolute URL (https://files.unsigned.sh).

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

require_command() {
  local name="$1"
  if ! command -v "${name}" >/dev/null 2>&1; then
    fail "required command not found: ${name}"
  fi
}

require_env() {
  local name="$1"
  if [[ -z ${!name:-} ]]; then
    fail "required environment variable is missing: ${name}"
  fi
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

cf_api_get() {
  local path="$1"
  curl -fsS \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}${path}"
}

cf_api_delete() {
  local path="$1"
  curl -fsS \
    -X DELETE \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}${path}"
}

cf_api_get_paginated_results() {
  local path="$1"
  local resource_name="$2"
  local page=1
  local total_pages=1
  local all_results='[]'

  while :; do
    local separator="?"
    if [[ ${path} == *\?* ]]; then
      separator="&"
    fi

    local response
    response="$(cf_api_get "${path}${separator}page=${page}&per_page=50")"

    local success
    success="$(jq -r '.success' <<<"${response}")"
    if [[ ${success} != "true" ]]; then
      fail "Cloudflare ${resource_name} API returned success=${success} (page ${page})"
    fi

    local page_results
    page_results="$(jq -c '.result // []' <<<"${response}")"
    all_results="$(jq -cn --argjson acc "${all_results}" --argjson page_data "${page_results}" '$acc + $page_data')"

    total_pages="$(jq -r '.result_info.total_pages // 1' <<<"${response}")"
    if [[ ! ${total_pages} =~ ^[0-9]+$ ]] || [[ ${total_pages} -lt 1 ]]; then
      total_pages=1
    fi

    if ((page >= total_pages)); then
      break
    fi
    ((page += 1))
  done

  printf '%s\n' "${all_results}"
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -ne 1 ]]; then
  usage >&2
  fail "expected 1 argument, got $#"
fi

require_command "curl"
require_command "jq"
require_env "CLOUDFLARE_API_TOKEN"
require_env "CLOUDFLARE_ACCOUNT_ID"

host="$(normalize_host "$1")"
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

echo "Removing ${stale_count} stale Access app(s) for ${host}:"
jq -r '.[] | "- id=\(.id) domain=\(.domain) name=\(.name) aud=\(.aud)"' <<<"${stale_apps_json}"

while IFS= read -r app_id; do
  [[ -n ${app_id} ]] || continue
  delete_response="$(cf_api_delete "/access/apps/${app_id}")"
  delete_success="$(jq -r '.success' <<<"${delete_response}")"
  if [[ ${delete_success} != "true" ]]; then
    fail "failed deleting Access app ${app_id}: $(jq -c '.errors // []' <<<"${delete_response}")"
  fi
done < <(jq -r '.[].id' <<<"${stale_apps_json}")

echo "Stale Access gate cleanup complete for ${host}"
