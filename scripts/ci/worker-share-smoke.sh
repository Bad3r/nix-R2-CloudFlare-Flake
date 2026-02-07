#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Error: $*" >&2
  exit 1
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

echo "Running Worker share smoke checks against ${R2E_SMOKE_BASE_URL}"
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
first_status="$(
  curl -sS -L --max-time 60 --connect-timeout 10 \
    -o "${first_download_body}" \
    -w "%{http_code}" \
    "${share_url}"
)"
if [[ ${first_status} != "200" ]]; then
  dump_response_context "${first_status}" "${first_download_body}" "first download"
  fail "first share download expected HTTP 200, got ${first_status}"
fi

second_download_body="${tmp_dir}/second-download.body"
second_status="$(
  curl -sS -L --max-time 60 --connect-timeout 10 \
    -o "${second_download_body}" \
    -w "%{http_code}" \
    "${share_url}"
)"
if [[ ${second_status} != "410" ]]; then
  dump_response_context "${second_status}" "${second_download_body}" "second download"
  fail "second share download expected HTTP 410 after max-downloads=1, got ${second_status}"
fi

api_probe_body="${tmp_dir}/api-probe.body"
api_probe_status="$(
  curl -sS --max-time 30 --connect-timeout 10 \
    -o "${api_probe_body}" \
    -w "%{http_code}" \
    "${R2E_SMOKE_BASE_URL%/}/api/server/info"
)"
if [[ ${api_probe_status} != "401" ]]; then
  dump_response_context "${api_probe_status}" "${api_probe_body}" "unauthenticated API probe"
  fail "unauthenticated /api/server/info expected HTTP 401, got ${api_probe_status}"
fi

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
