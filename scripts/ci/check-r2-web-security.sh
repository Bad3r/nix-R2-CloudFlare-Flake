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
  (none)

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
