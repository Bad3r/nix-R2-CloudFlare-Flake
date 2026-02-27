#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Error: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:
  check-r2-access-policy.sh <host> <expected-api-aud> <service-token-client-id>

Arguments:
  host                     App host without scheme (for example, files.unsigned.sh).
  expected-api-aud         Expected Access audience for host/api/v2/*.
  service-token-client-id  Client ID used by CI smoke probes for Service Auth.

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

cf_api_get() {
  local path="$1"
  curl -fsS \
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

if [[ $# -ne 3 ]]; then
  usage >&2
  fail "expected 3 arguments, got $#"
fi

host="$1"
expected_api_aud="$2"
service_token_client_id="$3"

if [[ -z ${host} ]]; then
  fail "host must not be empty"
fi
if [[ -z ${expected_api_aud} ]]; then
  fail "expected API aud must not be empty"
fi
if [[ -z ${service_token_client_id} ]]; then
  fail "service token client id must not be empty"
fi

require_command "curl"
require_command "jq"
require_env "CLOUDFLARE_API_TOKEN"
require_env "CLOUDFLARE_ACCOUNT_ID"

api_domain="${host}/api/v2/*"
share_domain="${host}/share/*"
legacy_share_domains=(
  "${host}/api/v2/share/*"
  "${host}/api/share/*"
)

apps_results_json="$(cf_api_get_paginated_results "/access/apps" "Access apps")"

api_app_count="$(
  jq -r --arg domain "${api_domain}" '[.[] | select(.domain == $domain)] | length' <<<"${apps_results_json}"
)"
if [[ ${api_app_count} != "1" ]]; then
  fail "expected exactly 1 Access app for ${api_domain}; found ${api_app_count}"
fi

api_app_id="$(jq -r --arg domain "${api_domain}" '.[] | select(.domain == $domain) | .id' <<<"${apps_results_json}")"
api_app_name="$(jq -r --arg domain "${api_domain}" '.[] | select(.domain == $domain) | .name' <<<"${apps_results_json}")"
api_app_aud="$(jq -r --arg domain "${api_domain}" '.[] | select(.domain == $domain) | .aud' <<<"${apps_results_json}")"

if [[ ${api_app_aud} != "${expected_api_aud}" ]]; then
  fail "API app aud mismatch for ${api_domain}: expected ${expected_api_aud}, got ${api_app_aud}"
fi

api_policies_json="$(cf_api_get "/access/apps/${api_app_id}/policies")"
api_policies_success="$(jq -r '.success' <<<"${api_policies_json}")"
if [[ ${api_policies_success} != "true" ]]; then
  fail "Cloudflare API returned success=${api_policies_success} for app ${api_app_id} policies"
fi

has_allow_policy="$(
  jq -r 'any(.result[]?; .decision == "allow")' <<<"${api_policies_json}"
)"
if [[ ${has_allow_policy} != "true" ]]; then
  fail "API app ${api_app_id} is missing an allow policy"
fi

has_api_bypass_policy="$(
  jq -r 'any(.result[]?; .decision == "bypass")' <<<"${api_policies_json}"
)"
if [[ ${has_api_bypass_policy} == "true" ]]; then
  fail "API app ${api_app_id} contains a bypass policy; /api/v2/* must stay Access-protected"
fi

service_tokens_results_json="$(cf_api_get_paginated_results "/access/service_tokens" "Access service tokens")"

service_token_id="$(
  jq -r --arg client_id "${service_token_client_id}" \
    '.[] | select(.client_id == $client_id) | .id' <<<"${service_tokens_results_json}"
)"
token_count="$(printf '%s' "${service_token_id}" | wc -l)"
if [[ ${token_count} -gt 1 ]]; then
  echo "Warning: multiple service tokens found for client id ${service_token_client_id}; using first" >&2
fi
service_token_id="$(printf '%s' "${service_token_id}" | head -n1)"
if [[ -z ${service_token_id} ]]; then
  fail "no Cloudflare service token found for client id ${service_token_client_id}"
fi

has_service_auth_policy="$(
  jq -r --arg token_id "${service_token_id}" '
    any(
      .result[]?;
      .decision == "non_identity" and
      any(.include[]?; .service_token.token_id == $token_id)
    )' <<<"${api_policies_json}"
)"
if [[ ${has_service_auth_policy} != "true" ]]; then
  fail "API app ${api_app_id} is missing Service Auth policy for token ${service_token_id}"
fi

share_app_count="$(
  jq -r --arg domain "${share_domain}" '[.[] | select(.domain == $domain)] | length' <<<"${apps_results_json}"
)"
if [[ ${share_app_count} != "1" ]]; then
  fail "expected exactly 1 Access app for ${share_domain}; found ${share_app_count}"
fi

share_app_id="$(jq -r --arg domain "${share_domain}" '.[] | select(.domain == $domain) | .id' <<<"${apps_results_json}")"
share_policies_json="$(cf_api_get "/access/apps/${share_app_id}/policies")"
share_policies_success="$(jq -r '.success' <<<"${share_policies_json}")"
if [[ ${share_policies_success} != "true" ]]; then
  fail "Cloudflare API returned success=${share_policies_success} for share app ${share_app_id} policies"
fi

has_share_bypass_policy="$(
  jq -r 'any(.result[]?; .decision == "bypass")' <<<"${share_policies_json}"
)"
if [[ ${has_share_bypass_policy} != "true" ]]; then
  fail "share app ${share_app_id} is missing bypass policy"
fi

for legacy_domain in "${legacy_share_domains[@]}"; do
  legacy_count="$(
    jq -r --arg domain "${legacy_domain}" '[.[] | select(.domain == $domain)] | length' <<<"${apps_results_json}"
  )"
  if [[ ${legacy_count} != "0" ]]; then
    fail "found deprecated Access app domain ${legacy_domain}; remove stale bypass app(s)"
  fi
done

echo "Access policy contract verified for ${host}"
echo "api_app_id=${api_app_id} api_app_name=${api_app_name} api_aud=${api_app_aud}"
echo "share_app_id=${share_app_id} share_domain=${share_domain}"
echo "service_token_id=${service_token_id}"
