# Shared helpers for scripts/ci/*.sh.
#
# This file is sourced, not executed. Consumers load it with:
#   SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
#   # shellcheck source=scripts/ci/lib.sh
#   source "${SCRIPT_DIR}/lib.sh"
#
# shellcheck shell=bash

fail() {
  echo "Error: $*" >&2
  exit 1
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

normalize_space() {
  tr '\n' ' ' | tr -s '[:space:]' ' ' | sed -E 's/^ +| +$//g'
}

# Cloudflare account-scoped GET.
# Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.
cf_api_get() {
  local path="$1"
  curl -fsS \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}${path}"
}

# Collect all pages of a Cloudflare list endpoint into one JSON array.
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
