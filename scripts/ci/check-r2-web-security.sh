#!/usr/bin/env bash
set -euo pipefail

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
  R2E_SMOKE_ACCESS_CLIENT_ID      Cloudflare Access service token client id.
  R2E_SMOKE_ACCESS_CLIENT_SECRET  Cloudflare Access service token client secret.

Notes:
  - The script performs a protected-page fetch and checks:
    1) Effective response CSP equals expected policy.
    2) Analytics loader markers are present in HTML.
    3) Known empty-content SRI hash marker is absent.
USAGE
}

require_command() {
  local name="$1"
  if ! command -v "${name}" >/dev/null 2>&1; then
    fail "required command not found: ${name}"
  fi
}

normalize_space() {
  tr '\n' ' ' | tr -s '[:space:]' ' ' | sed -E 's/^ +| +$//g'
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

require_command "curl"
require_command "rg"

base_url="$1"
expected_csp_file="$2"

if [[ ! -f ${expected_csp_file} ]]; then
  fail "expected CSP file not found: ${expected_csp_file}"
fi

if [[ -z ${base_url} ]]; then
  fail "base URL must not be empty"
fi

request_url="${base_url%/}/"
headers_file="$(mktemp "${TMPDIR:-/tmp}/r2-web-security-headers.XXXXXX.txt")"
body_file="$(mktemp "${TMPDIR:-/tmp}/r2-web-security-body.XXXXXX.html")"

curl_headers=()
if [[ -n ${R2E_SMOKE_ACCESS_CLIENT_ID:-} || -n ${R2E_SMOKE_ACCESS_CLIENT_SECRET:-} ]]; then
  if [[ -z ${R2E_SMOKE_ACCESS_CLIENT_ID:-} || -z ${R2E_SMOKE_ACCESS_CLIENT_SECRET:-} ]]; then
    fail "set both R2E_SMOKE_ACCESS_CLIENT_ID and R2E_SMOKE_ACCESS_CLIENT_SECRET, or neither"
  fi
  curl_headers+=(
    -H "CF-Access-Client-Id: ${R2E_SMOKE_ACCESS_CLIENT_ID}"
    -H "CF-Access-Client-Secret: ${R2E_SMOKE_ACCESS_CLIENT_SECRET}"
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

expected_csp="$(normalize_space <"${expected_csp_file}")"
actual_csp="$(printf '%s' "${effective_csp}" | normalize_space)"

if [[ ${actual_csp} != "${expected_csp}" ]]; then
  echo "Expected CSP:" >&2
  echo "${expected_csp}" >&2
  echo "Actual CSP:" >&2
  echo "${actual_csp}" >&2
  fail "effective CSP does not match expected policy"
fi

if ! rg -q "/cdn-cgi/zaraz/" "${body_file}" && ! rg -q 'static\.cloudflareinsights\.com/beacon\.min\.js' "${body_file}"; then
  fail "analytics markers not found in HTML (expected Zaraz/Web Analytics loader)"
fi

if rg -q 'z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP\+DGNKHfuwvY7kxvUdBeoGlODJ6\+SfaPg==' "${body_file}"; then
  fail "detected empty-content sha512 marker associated with broken SRI fetches"
fi

echo "Web security checks passed for ${request_url}"
echo "CSP: ${actual_csp}"
