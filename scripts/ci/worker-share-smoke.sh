#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Error: $*" >&2
  exit 1
}

parse_positive_int() {
  local value="$1"
  local name="$2"
  local fallback="$3"

  if [[ -z ${value} ]]; then
    echo "${fallback}"
    return
  fi

  if [[ ! ${value} =~ ^[0-9]+$ ]] || [[ ${value} -le 0 ]]; then
    fail "${name} must be a positive integer (got '${value}')"
  fi

  echo "${value}"
}

parse_non_negative_int() {
  local value="$1"
  local name="$2"
  local fallback="$3"

  if [[ -z ${value} ]]; then
    echo "${fallback}"
    return
  fi

  if [[ ! ${value} =~ ^[0-9]+$ ]]; then
    fail "${name} must be a non-negative integer (got '${value}')"
  fi

  echo "${value}"
}

require_env() {
  local name="$1"
  if [[ -z ${!name:-} ]]; then
    fail "required environment variable is missing: ${name}"
  fi
}

require_command() {
  local name="$1"
  if ! command -v "${name}" >/dev/null 2>&1; then
    fail "required command is not available in PATH: ${name}"
  fi
}

dump_response_context() {
  local status="$1"
  local body_file="$2"
  local label="$3"

  echo "${label} HTTP status: ${status}" >&2
  if [[ -s ${body_file} ]]; then
    echo "${label} response body:" >&2
    head -c 2048 "${body_file}" >&2 || true
    echo >&2
  fi
}

should_retry_status() {
  local status="$1"

  case "${status}" in
  408 | 425 | 429 | 500 | 502 | 503 | 504)
    return 0
    ;;
  *)
    return 1
    ;;
  esac
}

assert_http_status() {
  local expected_status="$1"
  local label="$2"
  local url="$3"
  local body_file="$4"
  local follow_redirects="$5"
  local max_attempts attempt status curl_exit
  local -a curl_args

  max_attempts=$((SMOKE_RETRIES + 1))
  curl_args=(
    -sS
    --max-time
    "${SMOKE_TIMEOUT_SEC}"
    --connect-timeout
    "${SMOKE_CONNECT_TIMEOUT_SEC}"
    -o
    "${body_file}"
    -w
    "%{http_code}"
  )

  if [[ ${follow_redirects} == "true" ]]; then
    curl_args+=(-L)
  fi

  for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
    set +e
    status="$(curl "${curl_args[@]}" "${url}")"
    curl_exit=$?
    set -e

    if [[ ${curl_exit} -eq 0 && ${status} == "${expected_status}" ]]; then
      return 0
    fi

    if ((attempt < max_attempts)); then
      if [[ ${curl_exit} -ne 0 ]] || should_retry_status "${status}"; then
        echo "${label}: transient failure on attempt ${attempt}/${max_attempts}; retrying in ${SMOKE_RETRY_DELAY_SEC}s..." >&2
        sleep "${SMOKE_RETRY_DELAY_SEC}"
        continue
      fi
    fi

    dump_response_context "${status}" "${body_file}" "${label}"
    if [[ ${curl_exit} -ne 0 ]]; then
      fail "${label} request failed with curl exit ${curl_exit} (timeout=${SMOKE_TIMEOUT_SEC}s)"
    fi
    fail "${label} expected HTTP ${expected_status}, got ${status}"
  done
}

require_env "R2E_SMOKE_BASE_URL"
require_env "R2E_SMOKE_ADMIN_KID"
require_env "R2E_SMOKE_ADMIN_SECRET"
require_env "R2E_SMOKE_BUCKET"
require_env "R2E_SMOKE_KEY"

require_command "jq"
require_command "curl"

R2_BIN="${R2E_SMOKE_R2_BIN:-r2}"
if [[ ${R2_BIN} == */* ]]; then
  if [[ ! -x ${R2_BIN} ]]; then
    fail "r2 binary is not executable: ${R2_BIN}"
  fi
else
  if ! command -v "${R2_BIN}" >/dev/null 2>&1; then
    fail "r2 command is not available in PATH: ${R2_BIN}"
  fi
fi

export R2_EXPLORER_BASE_URL="${R2E_SMOKE_BASE_URL}"
export R2_EXPLORER_ADMIN_KID="${R2E_SMOKE_ADMIN_KID}"
export R2_EXPLORER_ADMIN_SECRET="${R2E_SMOKE_ADMIN_SECRET}"

ttl="${R2E_SMOKE_TTL:-10m}"
SMOKE_TIMEOUT_SEC="$(parse_positive_int "${R2E_SMOKE_TIMEOUT:-60}" "R2E_SMOKE_TIMEOUT" "60")"
SMOKE_CONNECT_TIMEOUT_SEC="$(parse_positive_int "${R2E_SMOKE_CONNECT_TIMEOUT:-10}" "R2E_SMOKE_CONNECT_TIMEOUT" "10")"
SMOKE_RETRIES="$(parse_non_negative_int "${R2E_SMOKE_RETRIES:-0}" "R2E_SMOKE_RETRIES" "0")"
SMOKE_RETRY_DELAY_SEC="$(parse_positive_int "${R2E_SMOKE_RETRY_DELAY_SEC:-2}" "R2E_SMOKE_RETRY_DELAY_SEC" "2")"

echo "Running Worker share smoke checks against ${R2E_SMOKE_BASE_URL}"
echo "Smoke request config: timeout=${SMOKE_TIMEOUT_SEC}s connect_timeout=${SMOKE_CONNECT_TIMEOUT_SEC}s retries=${SMOKE_RETRIES}" >&2
create_json="$(
  "${R2_BIN}" share worker create \
    "${R2E_SMOKE_BUCKET}" \
    "${R2E_SMOKE_KEY}" \
    "${ttl}" \
    --max-downloads 1
)"

token_id="$(jq -r '.tokenId // empty' <<<"${create_json}")"
share_url="$(jq -r '.url // empty' <<<"${create_json}")"
expires_at="$(jq -r '.expiresAt // empty' <<<"${create_json}")"

if [[ -z ${token_id} ]]; then
  fail "share creation response did not include tokenId"
fi
if [[ -z ${share_url} ]]; then
  fail "share creation response did not include url"
fi
if [[ -z ${expires_at} ]]; then
  fail "share creation response did not include expiresAt"
fi

echo "Created smoke share token ${token_id} (expires ${expires_at})"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/worker-smoke.XXXXXX")"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

first_download_body="${tmp_dir}/first-download.body"
assert_http_status "200" "first download" "${share_url}" "${first_download_body}" "true"

second_download_body="${tmp_dir}/second-download.body"
assert_http_status "410" "second download" "${share_url}" "${second_download_body}" "true"

api_probe_body="${tmp_dir}/api-probe.body"
assert_http_status "401" "unauthenticated API probe" "${R2E_SMOKE_BASE_URL%/}/api/server/info" "${api_probe_body}" "false"

api_error_code="$(jq -r '.error.code // empty' "${api_probe_body}" 2>/dev/null || true)"
if [[ -n ${api_error_code} && ${api_error_code} != "access_required" ]]; then
  fail "unauthenticated /api/server/info returned unexpected error code: ${api_error_code}"
fi

revoke_json="$("${R2_BIN}" share worker revoke "${token_id}")"
revoked="$(jq -r '.revoked // empty' <<<"${revoke_json}")"
if [[ ${revoked} != "true" ]]; then
  fail "share revoke response did not confirm revoked=true"
fi

echo "Worker smoke checks passed."
