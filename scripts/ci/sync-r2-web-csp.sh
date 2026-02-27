#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Error: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:
  sync-r2-web-csp.sh <web-hostname> <csp-policy-file>

Arguments:
  web-hostname      Protected web host (for example, files.unsigned.sh).
  csp-policy-file   File containing canonical CSP policy text.

Environment (required):
  CLOUDFLARE_API_TOKEN  Cloudflare API token with:
                        - Zone Rulesets Write
                        - Zone Rulesets Read
  R2E_CF_ZONE_NAME      Zone name (for example, unsigned.sh).

Environment (optional):
  R2E_CF_ZONE_ID                Explicit zone ID override.
  R2E_WEB_CSP_RULE_REF          Rule ref identifier (default: r2-explorer-web-csp).
  R2E_WEB_CSP_RULE_DESCRIPTION  Rule description for operator clarity.
  R2E_WEB_CSP_RULE_EXPRESSION   Explicit rule expression override.
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

normalize_space() {
  tr '\n' ' ' | tr -s '[:space:]' ' ' | sed -E 's/^ +| +$//g'
}

read_csp_policy() {
  local path="$1"
  sed -E '/^[[:space:]]*#/d;/^[[:space:]]*$/d' "${path}" | normalize_space
}

cf_api() {
  local method="$1"
  local path="$2"
  local payload_file="${3:-}"
  local response_file
  local http_code

  response_file="$(mktemp "${tmp_dir}/api-response.XXXXXX.json")"

  if [[ -n ${payload_file} ]]; then
    http_code="$(
      curl -sS \
        --request "${method}" \
        --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
        --header "Content-Type: application/json" \
        --output "${response_file}" \
        --write-out '%{http_code}' \
        --data "@${payload_file}" \
        "https://api.cloudflare.com/client/v4${path}"
    )"
  else
    http_code="$(
      curl -sS \
        --request "${method}" \
        --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
        --header "Content-Type: application/json" \
        --output "${response_file}" \
        --write-out '%{http_code}' \
        "https://api.cloudflare.com/client/v4${path}"
    )"
  fi

  if [[ ! ${http_code} =~ ^[0-9]{3}$ ]]; then
    fail "unexpected HTTP status while calling ${path}: ${http_code}"
  fi

  if ((http_code >= 400)); then
    echo "Cloudflare API error (${method} ${path}, HTTP ${http_code}):" >&2
    cat "${response_file}" >&2
    fail "Cloudflare API request failed"
  fi

  if jq -e '.success == false' "${response_file}" >/dev/null 2>&1; then
    echo "Cloudflare API reported success=false (${method} ${path}):" >&2
    jq -r '.errors' "${response_file}" >&2
    fail "Cloudflare API returned success=false"
  fi

  cat "${response_file}"
}

ensure_response_headers_ruleset() {
  local zone_id="$1"
  local response_file
  local http_code
  local create_payload

  response_file="$(mktemp "${tmp_dir}/entrypoint-response.XXXXXX.json")"
  http_code="$(
    curl -sS \
      --request GET \
      --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      --header "Content-Type: application/json" \
      --output "${response_file}" \
      --write-out '%{http_code}' \
      "https://api.cloudflare.com/client/v4/zones/${zone_id}/rulesets/phases/http_response_headers_transform/entrypoint"
  )"

  if [[ ${http_code} == "404" ]]; then
    create_payload="$(mktemp "${tmp_dir}/create-ruleset-payload.XXXXXX.json")"
    jq -n \
      --arg name "default" \
      --arg kind "zone" \
      --arg phase "http_response_headers_transform" \
      '{name: $name, kind: $kind, phase: $phase, rules: []}' >"${create_payload}"

    cf_api "POST" "/zones/${zone_id}/rulesets" "${create_payload}" | jq -r '.result.id'
    return
  fi

  if ((http_code >= 400)); then
    echo "Cloudflare API error (GET entrypoint, HTTP ${http_code}):" >&2
    cat "${response_file}" >&2
    fail "failed to read response-header transform entrypoint ruleset"
  fi

  if jq -e '.success == false' "${response_file}" >/dev/null 2>&1; then
    echo "Cloudflare API reported success=false while reading entrypoint ruleset:" >&2
    jq -r '.errors' "${response_file}" >&2
    fail "entrypoint ruleset query returned success=false"
  fi

  jq -r '.result.id // empty' "${response_file}"
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -ne 2 ]]; then
  usage >&2
  fail "expected 2 arguments, got $#"
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/r2-web-csp.XXXXXX")"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT INT TERM HUP

require_command "curl"
require_command "jq"
require_env "CLOUDFLARE_API_TOKEN"
require_env "R2E_CF_ZONE_NAME"

web_hostname="$1"
csp_policy_file="$2"

if [[ -z ${web_hostname} ]]; then
  fail "web hostname must not be empty"
fi

if [[ ! -f ${csp_policy_file} ]]; then
  fail "CSP policy file not found: ${csp_policy_file}"
fi

csp_policy="$(read_csp_policy "${csp_policy_file}")"
if [[ -z ${csp_policy} ]]; then
  fail "CSP policy file resolved to an empty policy: ${csp_policy_file}"
fi

rule_ref="${R2E_WEB_CSP_RULE_REF:-r2-explorer-web-csp}"
rule_description="${R2E_WEB_CSP_RULE_DESCRIPTION:-R2 Explorer web CSP (analytics-enabled)}"
default_expression="(http.host eq \"${web_hostname}\" and not (http.request.uri.path eq \"/api/v2\" or starts_with(http.request.uri.path, \"/api/v2/\") or http.request.uri.path eq \"/share\" or starts_with(http.request.uri.path, \"/share/\")))"
rule_expression="${R2E_WEB_CSP_RULE_EXPRESSION:-${default_expression}}"

if [[ -n ${R2E_CF_ZONE_ID:-} ]]; then
  zone_id="${R2E_CF_ZONE_ID}"
else
  zone_lookup_response="$(cf_api "GET" "/zones?name=${R2E_CF_ZONE_NAME}&status=active&per_page=1")"
  zone_id="$(printf '%s' "${zone_lookup_response}" | jq -r '.result[0].id // empty')"
fi

if [[ -z ${zone_id} ]]; then
  fail "could not resolve zone id for zone name: ${R2E_CF_ZONE_NAME}"
fi

ruleset_id="$(ensure_response_headers_ruleset "${zone_id}")"
if [[ -z ${ruleset_id} ]]; then
  fail "could not resolve response-header transform ruleset id for zone ${zone_id}"
fi

entrypoint_response="$(cf_api "GET" "/zones/${zone_id}/rulesets/phases/http_response_headers_transform/entrypoint")"
existing_rule_id="$(
  printf '%s' "${entrypoint_response}" | jq -r --arg ref "${rule_ref}" '
    .result.rules[]? | select(.ref == $ref) | .id
  ' | head -n 1
)"

rule_payload="$(mktemp "${tmp_dir}/rule-payload.XXXXXX.json")"
jq -n \
  --arg ref "${rule_ref}" \
  --arg description "${rule_description}" \
  --arg expression "${rule_expression}" \
  --arg csp "${csp_policy}" \
  '{
    ref: $ref,
    description: $description,
    expression: $expression,
    action: "rewrite",
    enabled: true,
    action_parameters: {
      headers: {
        "Content-Security-Policy": {
          operation: "set",
          value: $csp
        }
      }
    }
  }' >"${rule_payload}"

if [[ -n ${existing_rule_id} ]]; then
  cf_api "PATCH" "/zones/${zone_id}/rulesets/${ruleset_id}/rules/${existing_rule_id}" "${rule_payload}" >/dev/null
  echo "Updated existing CSP transform rule ${existing_rule_id} on zone ${zone_id}."
else
  cf_api "POST" "/zones/${zone_id}/rulesets/${ruleset_id}/rules" "${rule_payload}" >/dev/null
  echo "Created CSP transform rule '${rule_ref}' on zone ${zone_id}."
fi

final_entrypoint="$(cf_api "GET" "/zones/${zone_id}/rulesets/phases/http_response_headers_transform/entrypoint")"
actual_csp="$(
  printf '%s' "${final_entrypoint}" | jq -r --arg ref "${rule_ref}" '
    .result.rules[]? | select(.ref == $ref) | .action_parameters.headers["Content-Security-Policy"].value // empty
  ' | head -n 1 | normalize_space
)"

expected_csp="$(printf '%s' "${csp_policy}" | normalize_space)"

if [[ ${actual_csp} != "${expected_csp}" ]]; then
  echo "Expected CSP: ${expected_csp}" >&2
  echo "Actual CSP: ${actual_csp}" >&2
  fail "post-sync verification failed for CSP transform rule"
fi

echo "CSP transform sync completed for host ${web_hostname} in zone ${zone_id}."
