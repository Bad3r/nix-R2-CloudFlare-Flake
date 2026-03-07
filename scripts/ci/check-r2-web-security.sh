#!/usr/bin/env bash
set -euo pipefail

# base64(sha512(empty content)); used as broken-SRI empty-body sentinel.
EMPTY_BODY_SHA512_B64='z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=='

fail() {
  echo "Error: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:
  check-r2-web-security.sh <base-url> <expected-csp-file>

Arguments:
  base-url            Deployed web base URL (for example, https://files.unsigned.sh).
  expected-csp-file   Path to the canonical CSP policy text file.

Environment (optional):
  CF_CI_ENVIRONMENT                          Optional selector: preview or production.
  CF_PREVIEW_CI_SERVICE_TOKEN_CLIENT_ID     Preview Access service token client ID for protected web roots.
  CF_PREVIEW_CI_SERVICE_TOKEN_CLIENT_SECRET Preview Access service token secret for protected web roots.
  CF_PRODUCTION_CI_SERVICE_TOKEN_CLIENT_ID  Production Access service token client ID for protected web roots.
  CF_PRODUCTION_CI_SERVICE_TOKEN_CLIENT_SECRET
                                            Production Access service token secret for protected web roots.

Notes:
  - The script performs a protected-page fetch and checks:
    1) Effective response CSP equals normalized expected policy.
    2) Analytics is detectable via HTML loader markers or Zaraz runtime endpoint.
    3) Known empty-content SRI hash marker is absent.
USAGE
}

require_command() {
  local name="$1"
  if ! command -v "${name}" >/dev/null 2>&1; then
    fail "required command not found: ${name}"
  fi
}

uppercase_env_name() {
  local value="$1"
  printf '%s' "${value}" | tr '[:lower:]' '[:upper:]'
}

infer_ci_environment() {
  local preview_count production_count

  preview_count="$(env | awk -F= '/^CF_PREVIEW_CI_/ {count += 1} END {print count + 0}')"
  production_count="$(env | awk -F= '/^CF_PRODUCTION_CI_/ {count += 1} END {print count + 0}')"

  if [[ ${preview_count} -gt 0 && ${production_count} -gt 0 ]]; then
    fail "detected both CF_PREVIEW_CI_* and CF_PRODUCTION_CI_* variables; set CF_CI_ENVIRONMENT to disambiguate"
  fi
  if [[ ${preview_count} -gt 0 ]]; then
    echo "preview"
    return
  fi
  if [[ ${production_count} -gt 0 ]]; then
    echo "production"
    return
  fi

  # Access headers are optional for this script; no env family means no token headers.
  echo ""
}

resolve_prefixed_var_name_for_env() {
  local env_name="$1"
  local suffix="$2"
  local env_upper
  env_upper="$(uppercase_env_name "${env_name}")"
  printf 'CF_%s_CI_%s' "${env_upper}" "${suffix}"
}

normalize_space() {
  tr '\n' ' ' | tr -s '[:space:]' ' ' | sed -E 's/^ +| +$//g'
}

read_csp_policy() {
  local path="$1"
  sed -E '/^[[:space:]]*#/d;/^[[:space:]]*$/d' "${path}" | normalize_space
}

extract_csp_header() {
  local header_path="$1"
  awk '
    tolower($1) == "content-security-policy:" {
      $1 = "";
      sub(/^ /, "", $0);
      sub(/\r$/, "", $0);
      print;
      found = 1;
    }
    END {
      if (!found) {
        exit 1;
      }
    }
  ' "${header_path}"
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -ne 2 ]]; then
  usage >&2
  fail "expected 2 arguments, got $#"
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/r2-web-security.XXXXXX")"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT INT TERM

require_command "curl"
require_command "grep"

base_url="$1"
expected_csp_file="$2"

if [[ ! -f ${expected_csp_file} ]]; then
  fail "expected CSP file not found: ${expected_csp_file}"
fi

if [[ -z ${base_url} ]]; then
  fail "base URL must not be empty"
fi

request_url="${base_url%/}/"
headers_file="${tmp_dir}/headers.txt"
body_file="${tmp_dir}/body.html"

curl_headers=()
ci_environment_raw="${CF_CI_ENVIRONMENT:-}"
if [[ -n ${ci_environment_raw} ]]; then
  ci_environment="$(printf '%s' "${ci_environment_raw}" | tr '[:upper:]' '[:lower:]')"
  if [[ ${ci_environment} != "preview" && ${ci_environment} != "production" ]]; then
    fail "CF_CI_ENVIRONMENT must be 'preview' or 'production' (got '${ci_environment_raw}')"
  fi
else
  ci_environment="$(infer_ci_environment)"
fi

access_client_id=""
access_client_secret=""
if [[ -n ${ci_environment} ]]; then
  access_client_id_var="$(resolve_prefixed_var_name_for_env "${ci_environment}" "SERVICE_TOKEN_CLIENT_ID")"
  access_client_secret_var="$(resolve_prefixed_var_name_for_env "${ci_environment}" "SERVICE_TOKEN_CLIENT_SECRET")"
  access_client_id="${!access_client_id_var:-}"
  access_client_secret="${!access_client_secret_var:-}"
fi

if [[ -n ${access_client_id} || -n ${access_client_secret} ]]; then
  if [[ -z ${access_client_id} || -z ${access_client_secret} ]]; then
    fail "service token client ID and secret must both be set when using Access headers"
  fi
  curl_headers+=(
    -H "CF-Access-Client-Id: ${access_client_id}"
    -H "CF-Access-Client-Secret: ${access_client_secret}"
  )
fi

http_code="$(
  curl -sS --location "${curl_headers[@]}" \
    --dump-header "${headers_file}" \
    --output "${body_file}" \
    --write-out '%{http_code}' \
    "${request_url}"
)"

if [[ ${http_code} != "200" ]]; then
  fail "expected HTTP 200 from ${request_url}, got ${http_code}"
fi

effective_csp="$(extract_csp_header "${headers_file}" | tail -n 1 || true)"
if [[ -z ${effective_csp} ]]; then
  fail "response did not include content-security-policy header"
fi

expected_csp="$(read_csp_policy "${expected_csp_file}")"
if [[ -z ${expected_csp} ]]; then
  fail "expected CSP file resolved to an empty policy: ${expected_csp_file}"
fi
actual_csp="$(printf '%s' "${effective_csp}" | normalize_space)"

if [[ ${actual_csp} != "${expected_csp}" ]]; then
  echo "Expected CSP:" >&2
  echo "${expected_csp}" >&2
  echo "Actual CSP:" >&2
  echo "${actual_csp}" >&2
  fail "effective CSP does not match expected policy"
fi

if ! grep -q "/cdn-cgi/zaraz/" "${body_file}" && ! grep -Eq 'static\.cloudflareinsights\.com/beacon\.min\.js' "${body_file}"; then
  # Zaraz/Web Analytics may be injected at runtime by Cloudflare and absent from raw curl HTML.
  zaraz_probe_status="$(
    curl -sS --location "${curl_headers[@]}" \
      --output /dev/null \
      --write-out '%{http_code}' \
      "${request_url%/}/cdn-cgi/zaraz/s.js"
  )"
  if [[ ${zaraz_probe_status} == "404" ]]; then
    fail "analytics markers not found in HTML and Zaraz endpoint unavailable"
  fi
fi

if grep -F -q "${EMPTY_BODY_SHA512_B64}" "${body_file}"; then
  fail "detected empty-content sha512 marker associated with broken SRI fetches"
fi

echo "Web security checks passed for ${request_url}"
echo "CSP: ${actual_csp}"
