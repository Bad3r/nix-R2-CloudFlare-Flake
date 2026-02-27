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

apps_json="$(cf_api_get "/access/apps")"
apps_success="$(jq -r '.success' <<<"${apps_json}")"
if [[ ${apps_success} != "true" ]]; then
  fail "Cloudflare Access apps API returned success=${apps_success}"
fi

api_app_count="$(
  jq -r --arg domain "${api_domain}" '[.result[] | select(.domain == $domain)] | length' <<<"${apps_json}"
)"
if [[ ${api_app_count} != "1" ]]; then
  fail "expected exactly 1 Access app for ${api_domain}; found ${api_app_count}"
fi

api_app_id="$(jq -r --arg domain "${api_domain}" '.result[] | select(.domain == $domain) | .id' <<<"${apps_json}")"
api_app_name="$(jq -r --arg domain "${api_domain}" '.result[] | select(.domain == $domain) | .name' <<<"${apps_json}")"
api_app_aud="$(jq -r --arg domain "${api_domain}" '.result[] | select(.domain == $domain) | .aud' <<<"${apps_json}")"

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

service_tokens_json="$(cf_api_get "/access/service_tokens")"
service_tokens_success="$(jq -r '.success' <<<"${service_tokens_json}")"
if [[ ${service_tokens_success} != "true" ]]; then
  fail "Cloudflare Access service tokens API returned success=${service_tokens_success}"
fi

service_token_id="$(
  jq -r --arg client_id "${service_token_client_id}" \
    '.result[] | select(.client_id == $client_id) | .id' <<<"${service_tokens_json}" | head -n1
service_token_id="$(
  jq -r --arg client_id "${service_token_client_id}" \
    '.result[] | select(.client_id == $client_id) | .id' <<<"${service_tokens_json}"
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
  jq -r --arg domain "${share_domain}" '[.result[] | select(.domain == $domain)] | length' <<<"${apps_json}"
)"
if [[ ${share_app_count} != "1" ]]; then
  fail "expected exactly 1 Access app for ${share_domain}; found ${share_app_count}"
fi

share_app_id="$(jq -r --arg domain "${share_domain}" '.result[] | select(.domain == $domain) | .id' <<<"${apps_json}")"
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
    jq -r --arg domain "${legacy_domain}" '[.result[] | select(.domain == $domain)] | length' <<<"${apps_json}"
  )"
  if [[ ${legacy_count} != "0" ]]; then
    fail "found deprecated Access app domain ${legacy_domain}; remove stale bypass app(s)"
  fi
done

echo "Access policy contract verified for ${host}"
echo "api_app_id=${api_app_id} api_app_name=${api_app_name} api_aud=${api_app_aud}"
echo "share_app_id=${share_app_id} share_domain=${share_domain}"
echo "service_token_id=${service_token_id}"
