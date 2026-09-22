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

# Resolves a positive-integer env var with a default, failing loudly on an
# invalid (non-positive-integer) override.
resolve_positive_int_env() {
  local name="$1"
  local default="$2"
  local value="${!name:-${default}}"
  if [[ ! ${value} =~ ^[0-9]+$ ]] || [[ ${value} -le 0 ]]; then
    fail "${name} must be a positive integer (got '${value}')"
  fi
  printf '%s' "${value}"
}

# Cloudflare API request bounds shared by every scripts/ci/*.sh caller of the
# helpers below, overridable per the convention worker-share-smoke.sh already
# uses (SMOKE_TIMEOUT_SEC / SMOKE_CONNECT_TIMEOUT_SEC).
CF_API_TIMEOUT_SEC="$(resolve_positive_int_env "CF_API_TIMEOUT_SEC" "60")"
CF_API_CONNECT_TIMEOUT_SEC="$(resolve_positive_int_env "CF_API_CONNECT_TIMEOUT_SEC" "10")"

# Cloudflare account-scoped GET.
# Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.
cf_api_get() {
  local path="$1"
  local response_file http_code

  response_file="$(mktemp "${TMPDIR:-/tmp}/cf-api-get.XXXXXX.json")"
  # Callers capture this function with $(...), where errexit is off: a curl
  # transport failure must be turned into an explicit failure here.
  if ! http_code="$(
    curl -sS \
      --max-time "${CF_API_TIMEOUT_SEC}" \
      --connect-timeout "${CF_API_CONNECT_TIMEOUT_SEC}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      --output "${response_file}" \
      --write-out '%{http_code}' \
      "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}${path}"
  )"; then
    rm -f "${response_file}"
    fail "Cloudflare API request did not complete (GET ${path}, limit ${CF_API_TIMEOUT_SEC}s); see the curl error above"
  fi

  if [[ ! ${http_code} =~ ^[0-9]{3}$ ]]; then
    rm -f "${response_file}"
    fail "unexpected HTTP status while calling ${path}: ${http_code}"
  fi

  if ((http_code >= 400)); then
    echo "Cloudflare API error (GET ${path}, HTTP ${http_code}):" >&2
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
      echo "Cloudflare ${resource_name} API returned success=false (page ${page}):" >&2
      jq -r '.errors // .' <<<"${response}" >&2
      fail "Cloudflare ${resource_name} API request failed"
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
