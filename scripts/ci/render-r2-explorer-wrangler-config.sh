#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name="$1"
  if [[ -z ${!name:-} ]]; then
    echo "Error: required environment variable is missing: ${name}" >&2
    exit 1
  fi
}

require_command() {
  local name="$1"
  if ! command -v "${name}" >/dev/null 2>&1; then
    echo "Error: required command is not available in PATH: ${name}" >&2
    exit 1
  fi
}

escape_sed_replacement() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g' -e 's/"/\\\\"/g'
}

main() {
  local output_path template_path
  output_path="${1:-r2-explorer/wrangler.ci.toml}"
  template_path="${2:-r2-explorer/wrangler.toml}"

  require_env "R2E_FILES_BUCKET"
  require_env "R2E_FILES_BUCKET_PREVIEW"
  require_env "R2E_SHARES_KV_ID"
  require_env "R2E_SHARES_KV_ID_PREVIEW"
  require_env "R2E_KEYS_KV_ID"
  require_env "R2E_KEYS_KV_ID_PREVIEW"
  require_env "R2E_ACCESS_TEAM_DOMAIN"
  require_env "R2E_ACCESS_TEAM_DOMAIN_PREVIEW"
  require_env "R2E_ACCESS_AUD"
  require_env "R2E_ACCESS_AUD_PREVIEW"

  bucket_map="${R2E_BUCKET_MAP:-}"
  if [[ -z ${bucket_map} ]]; then
    require_command "python3"
    bucket_map="$(
      python3 - <<'PY'
import json
import os

bucket_map = {"files": "FILES_BUCKET"}
files_bucket = os.getenv("R2E_FILES_BUCKET", "")
preview_bucket = os.getenv("R2E_FILES_BUCKET_PREVIEW", "")

if files_bucket:
    bucket_map[files_bucket] = "FILES_BUCKET"
if preview_bucket and preview_bucket != files_bucket:
    bucket_map[preview_bucket] = "FILES_BUCKET"

print(json.dumps(bucket_map, separators=(",", ":")))
PY
    )"
  fi

  local upload_max_file_bytes upload_max_file_bytes_preview
  local upload_max_parts upload_max_parts_preview
  local upload_max_concurrent upload_max_concurrent_preview
  local upload_session_ttl upload_session_ttl_preview
  local upload_sign_ttl upload_sign_ttl_preview
  local upload_part_size upload_part_size_preview
  local upload_allowed_mime upload_allowed_mime_preview
  local upload_blocked_mime upload_blocked_mime_preview
  local upload_allowed_ext upload_allowed_ext_preview
  local upload_blocked_ext upload_blocked_ext_preview
  local upload_prefix_allowlist upload_prefix_allowlist_preview
  local upload_allowed_origins upload_allowed_origins_preview
  local upload_s3_bucket upload_s3_bucket_preview

  upload_max_file_bytes="${R2E_UPLOAD_MAX_FILE_BYTES:-0}"
  upload_max_file_bytes_preview="${R2E_UPLOAD_MAX_FILE_BYTES_PREVIEW:-${upload_max_file_bytes}}"
  upload_max_parts="${R2E_UPLOAD_MAX_PARTS:-0}"
  upload_max_parts_preview="${R2E_UPLOAD_MAX_PARTS_PREVIEW:-${upload_max_parts}}"
  upload_max_concurrent="${R2E_UPLOAD_MAX_CONCURRENT_PER_USER:-0}"
  upload_max_concurrent_preview="${R2E_UPLOAD_MAX_CONCURRENT_PER_USER_PREVIEW:-${upload_max_concurrent}}"
  upload_session_ttl="${R2E_UPLOAD_SESSION_TTL_SEC:-3600}"
  upload_session_ttl_preview="${R2E_UPLOAD_SESSION_TTL_SEC_PREVIEW:-${upload_session_ttl}}"
  upload_sign_ttl="${R2E_UPLOAD_SIGN_TTL_SEC:-60}"
  upload_sign_ttl_preview="${R2E_UPLOAD_SIGN_TTL_SEC_PREVIEW:-${upload_sign_ttl}}"
  upload_part_size="${R2E_UPLOAD_PART_SIZE_BYTES:-8388608}"
  upload_part_size_preview="${R2E_UPLOAD_PART_SIZE_BYTES_PREVIEW:-${upload_part_size}}"
  upload_allowed_mime="${R2E_UPLOAD_ALLOWED_MIME:-}"
  upload_allowed_mime_preview="${R2E_UPLOAD_ALLOWED_MIME_PREVIEW:-${upload_allowed_mime}}"
  upload_blocked_mime="${R2E_UPLOAD_BLOCKED_MIME:-}"
  upload_blocked_mime_preview="${R2E_UPLOAD_BLOCKED_MIME_PREVIEW:-${upload_blocked_mime}}"
  upload_allowed_ext="${R2E_UPLOAD_ALLOWED_EXT:-}"
  upload_allowed_ext_preview="${R2E_UPLOAD_ALLOWED_EXT_PREVIEW:-${upload_allowed_ext}}"
  upload_blocked_ext="${R2E_UPLOAD_BLOCKED_EXT:-}"
  upload_blocked_ext_preview="${R2E_UPLOAD_BLOCKED_EXT_PREVIEW:-${upload_blocked_ext}}"
  upload_prefix_allowlist="${R2E_UPLOAD_PREFIX_ALLOWLIST:-}"
  upload_prefix_allowlist_preview="${R2E_UPLOAD_PREFIX_ALLOWLIST_PREVIEW:-${upload_prefix_allowlist}}"
  upload_allowed_origins="${R2E_UPLOAD_ALLOWED_ORIGINS:-}"
  upload_allowed_origins_preview="${R2E_UPLOAD_ALLOWED_ORIGINS_PREVIEW:-${upload_allowed_origins}}"
  upload_s3_bucket="${R2E_UPLOAD_S3_BUCKET:-${R2E_FILES_BUCKET}}"
  upload_s3_bucket_preview="${R2E_UPLOAD_S3_BUCKET_PREVIEW:-${R2E_FILES_BUCKET_PREVIEW}}"

  escaped_bucket_map="$(escape_sed_replacement "${bucket_map}")"

  sed \
    -e "s|replace-with-r2-bucket-preview|$(escape_sed_replacement "${R2E_FILES_BUCKET_PREVIEW}")|g" \
    -e "s|replace-with-r2-bucket|$(escape_sed_replacement "${R2E_FILES_BUCKET}")|g" \
    -e "s|replace-with-shares-kv-namespace-id-preview|$(escape_sed_replacement "${R2E_SHARES_KV_ID_PREVIEW}")|g" \
    -e "s|replace-with-shares-kv-namespace-id|$(escape_sed_replacement "${R2E_SHARES_KV_ID}")|g" \
    -e "s|replace-with-keys-kv-namespace-id-preview|$(escape_sed_replacement "${R2E_KEYS_KV_ID_PREVIEW}")|g" \
    -e "s|replace-with-keys-kv-namespace-id|$(escape_sed_replacement "${R2E_KEYS_KV_ID}")|g" \
    -e "s|replace-with-access-team-domain-preview|$(escape_sed_replacement "${R2E_ACCESS_TEAM_DOMAIN_PREVIEW}")|g" \
    -e "s|replace-with-access-team-domain|$(escape_sed_replacement "${R2E_ACCESS_TEAM_DOMAIN}")|g" \
    -e "s|replace-with-access-aud-preview|$(escape_sed_replacement "${R2E_ACCESS_AUD_PREVIEW}")|g" \
    -e "s|replace-with-access-aud|$(escape_sed_replacement "${R2E_ACCESS_AUD}")|g" \
    -e "s|replace-with-upload-max-file-bytes-preview|$(escape_sed_replacement "${upload_max_file_bytes_preview}")|g" \
    -e "s|replace-with-upload-max-file-bytes|$(escape_sed_replacement "${upload_max_file_bytes}")|g" \
    -e "s|replace-with-upload-max-parts-preview|$(escape_sed_replacement "${upload_max_parts_preview}")|g" \
    -e "s|replace-with-upload-max-parts|$(escape_sed_replacement "${upload_max_parts}")|g" \
    -e "s|replace-with-upload-max-concurrent-per-user-preview|$(escape_sed_replacement "${upload_max_concurrent_preview}")|g" \
    -e "s|replace-with-upload-max-concurrent-per-user|$(escape_sed_replacement "${upload_max_concurrent}")|g" \
    -e "s|replace-with-upload-session-ttl-sec-preview|$(escape_sed_replacement "${upload_session_ttl_preview}")|g" \
    -e "s|replace-with-upload-session-ttl-sec|$(escape_sed_replacement "${upload_session_ttl}")|g" \
    -e "s|replace-with-upload-sign-ttl-sec-preview|$(escape_sed_replacement "${upload_sign_ttl_preview}")|g" \
    -e "s|replace-with-upload-sign-ttl-sec|$(escape_sed_replacement "${upload_sign_ttl}")|g" \
    -e "s|replace-with-upload-part-size-bytes-preview|$(escape_sed_replacement "${upload_part_size_preview}")|g" \
    -e "s|replace-with-upload-part-size-bytes|$(escape_sed_replacement "${upload_part_size}")|g" \
    -e "s|replace-with-upload-allowed-mime-preview|$(escape_sed_replacement "${upload_allowed_mime_preview}")|g" \
    -e "s|replace-with-upload-allowed-mime|$(escape_sed_replacement "${upload_allowed_mime}")|g" \
    -e "s|replace-with-upload-blocked-mime-preview|$(escape_sed_replacement "${upload_blocked_mime_preview}")|g" \
    -e "s|replace-with-upload-blocked-mime|$(escape_sed_replacement "${upload_blocked_mime}")|g" \
    -e "s|replace-with-upload-allowed-ext-preview|$(escape_sed_replacement "${upload_allowed_ext_preview}")|g" \
    -e "s|replace-with-upload-allowed-ext|$(escape_sed_replacement "${upload_allowed_ext}")|g" \
    -e "s|replace-with-upload-blocked-ext-preview|$(escape_sed_replacement "${upload_blocked_ext_preview}")|g" \
    -e "s|replace-with-upload-blocked-ext|$(escape_sed_replacement "${upload_blocked_ext}")|g" \
    -e "s|replace-with-upload-prefix-allowlist-preview|$(escape_sed_replacement "${upload_prefix_allowlist_preview}")|g" \
    -e "s|replace-with-upload-prefix-allowlist|$(escape_sed_replacement "${upload_prefix_allowlist}")|g" \
    -e "s|replace-with-upload-allowed-origins-preview|$(escape_sed_replacement "${upload_allowed_origins_preview}")|g" \
    -e "s|replace-with-upload-allowed-origins|$(escape_sed_replacement "${upload_allowed_origins}")|g" \
    -e "s|replace-with-upload-s3-bucket-preview|$(escape_sed_replacement "${upload_s3_bucket_preview}")|g" \
    -e "s|replace-with-upload-s3-bucket|$(escape_sed_replacement "${upload_s3_bucket}")|g" \
    -e "/^\\[vars\\]/,/^\\[\\[r2_buckets\\]\\]/ s|^R2E_UPLOAD_MAX_FILE_BYTES = \".*\"$|R2E_UPLOAD_MAX_FILE_BYTES = \"$(escape_sed_replacement "${upload_max_file_bytes}")\"|g" \
    -e "/^\\[vars\\]/,/^\\[\\[r2_buckets\\]\\]/ s|^R2E_UPLOAD_MAX_PARTS = \".*\"$|R2E_UPLOAD_MAX_PARTS = \"$(escape_sed_replacement "${upload_max_parts}")\"|g" \
    -e "/^\\[vars\\]/,/^\\[\\[r2_buckets\\]\\]/ s|^R2E_UPLOAD_MAX_CONCURRENT_PER_USER = \".*\"$|R2E_UPLOAD_MAX_CONCURRENT_PER_USER = \"$(escape_sed_replacement "${upload_max_concurrent}")\"|g" \
    -e "/^\\[vars\\]/,/^\\[\\[r2_buckets\\]\\]/ s|^R2E_UPLOAD_SESSION_TTL_SEC = \".*\"$|R2E_UPLOAD_SESSION_TTL_SEC = \"$(escape_sed_replacement "${upload_session_ttl}")\"|g" \
    -e "/^\\[vars\\]/,/^\\[\\[r2_buckets\\]\\]/ s|^R2E_UPLOAD_SIGN_TTL_SEC = \".*\"$|R2E_UPLOAD_SIGN_TTL_SEC = \"$(escape_sed_replacement "${upload_sign_ttl}")\"|g" \
    -e "/^\\[vars\\]/,/^\\[\\[r2_buckets\\]\\]/ s|^R2E_UPLOAD_PART_SIZE_BYTES = \".*\"$|R2E_UPLOAD_PART_SIZE_BYTES = \"$(escape_sed_replacement "${upload_part_size}")\"|g" \
    -e "/^\\[vars\\]/,/^\\[\\[r2_buckets\\]\\]/ s|^R2E_UPLOAD_ALLOWED_MIME = \".*\"$|R2E_UPLOAD_ALLOWED_MIME = \"$(escape_sed_replacement "${upload_allowed_mime}")\"|g" \
    -e "/^\\[vars\\]/,/^\\[\\[r2_buckets\\]\\]/ s|^R2E_UPLOAD_BLOCKED_MIME = \".*\"$|R2E_UPLOAD_BLOCKED_MIME = \"$(escape_sed_replacement "${upload_blocked_mime}")\"|g" \
    -e "/^\\[vars\\]/,/^\\[\\[r2_buckets\\]\\]/ s|^R2E_UPLOAD_ALLOWED_EXT = \".*\"$|R2E_UPLOAD_ALLOWED_EXT = \"$(escape_sed_replacement "${upload_allowed_ext}")\"|g" \
    -e "/^\\[vars\\]/,/^\\[\\[r2_buckets\\]\\]/ s|^R2E_UPLOAD_BLOCKED_EXT = \".*\"$|R2E_UPLOAD_BLOCKED_EXT = \"$(escape_sed_replacement "${upload_blocked_ext}")\"|g" \
    -e "/^\\[vars\\]/,/^\\[\\[r2_buckets\\]\\]/ s|^R2E_UPLOAD_PREFIX_ALLOWLIST = \".*\"$|R2E_UPLOAD_PREFIX_ALLOWLIST = \"$(escape_sed_replacement "${upload_prefix_allowlist}")\"|g" \
    -e "/^\\[vars\\]/,/^\\[\\[r2_buckets\\]\\]/ s|^R2E_UPLOAD_ALLOWED_ORIGINS = \".*\"$|R2E_UPLOAD_ALLOWED_ORIGINS = \"$(escape_sed_replacement "${upload_allowed_origins}")\"|g" \
    -e "/^\\[vars\\]/,/^\\[\\[r2_buckets\\]\\]/ s|^R2E_UPLOAD_S3_BUCKET = \".*\"$|R2E_UPLOAD_S3_BUCKET = \"$(escape_sed_replacement "${upload_s3_bucket}")\"|g" \
    -e "/^\\[env\\.preview\\.vars\\]/,/^\\[\\[env\\.preview\\.r2_buckets\\]\\]/ s|^R2E_UPLOAD_MAX_FILE_BYTES = \".*\"$|R2E_UPLOAD_MAX_FILE_BYTES = \"$(escape_sed_replacement "${upload_max_file_bytes_preview}")\"|g" \
    -e "/^\\[env\\.preview\\.vars\\]/,/^\\[\\[env\\.preview\\.r2_buckets\\]\\]/ s|^R2E_UPLOAD_MAX_PARTS = \".*\"$|R2E_UPLOAD_MAX_PARTS = \"$(escape_sed_replacement "${upload_max_parts_preview}")\"|g" \
    -e "/^\\[env\\.preview\\.vars\\]/,/^\\[\\[env\\.preview\\.r2_buckets\\]\\]/ s|^R2E_UPLOAD_MAX_CONCURRENT_PER_USER = \".*\"$|R2E_UPLOAD_MAX_CONCURRENT_PER_USER = \"$(escape_sed_replacement "${upload_max_concurrent_preview}")\"|g" \
    -e "/^\\[env\\.preview\\.vars\\]/,/^\\[\\[env\\.preview\\.r2_buckets\\]\\]/ s|^R2E_UPLOAD_SESSION_TTL_SEC = \".*\"$|R2E_UPLOAD_SESSION_TTL_SEC = \"$(escape_sed_replacement "${upload_session_ttl_preview}")\"|g" \
    -e "/^\\[env\\.preview\\.vars\\]/,/^\\[\\[env\\.preview\\.r2_buckets\\]\\]/ s|^R2E_UPLOAD_SIGN_TTL_SEC = \".*\"$|R2E_UPLOAD_SIGN_TTL_SEC = \"$(escape_sed_replacement "${upload_sign_ttl_preview}")\"|g" \
    -e "/^\\[env\\.preview\\.vars\\]/,/^\\[\\[env\\.preview\\.r2_buckets\\]\\]/ s|^R2E_UPLOAD_PART_SIZE_BYTES = \".*\"$|R2E_UPLOAD_PART_SIZE_BYTES = \"$(escape_sed_replacement "${upload_part_size_preview}")\"|g" \
    -e "/^\\[env\\.preview\\.vars\\]/,/^\\[\\[env\\.preview\\.r2_buckets\\]\\]/ s|^R2E_UPLOAD_ALLOWED_MIME = \".*\"$|R2E_UPLOAD_ALLOWED_MIME = \"$(escape_sed_replacement "${upload_allowed_mime_preview}")\"|g" \
    -e "/^\\[env\\.preview\\.vars\\]/,/^\\[\\[env\\.preview\\.r2_buckets\\]\\]/ s|^R2E_UPLOAD_BLOCKED_MIME = \".*\"$|R2E_UPLOAD_BLOCKED_MIME = \"$(escape_sed_replacement "${upload_blocked_mime_preview}")\"|g" \
    -e "/^\\[env\\.preview\\.vars\\]/,/^\\[\\[env\\.preview\\.r2_buckets\\]\\]/ s|^R2E_UPLOAD_ALLOWED_EXT = \".*\"$|R2E_UPLOAD_ALLOWED_EXT = \"$(escape_sed_replacement "${upload_allowed_ext_preview}")\"|g" \
    -e "/^\\[env\\.preview\\.vars\\]/,/^\\[\\[env\\.preview\\.r2_buckets\\]\\]/ s|^R2E_UPLOAD_BLOCKED_EXT = \".*\"$|R2E_UPLOAD_BLOCKED_EXT = \"$(escape_sed_replacement "${upload_blocked_ext_preview}")\"|g" \
    -e "/^\\[env\\.preview\\.vars\\]/,/^\\[\\[env\\.preview\\.r2_buckets\\]\\]/ s|^R2E_UPLOAD_PREFIX_ALLOWLIST = \".*\"$|R2E_UPLOAD_PREFIX_ALLOWLIST = \"$(escape_sed_replacement "${upload_prefix_allowlist_preview}")\"|g" \
    -e "/^\\[env\\.preview\\.vars\\]/,/^\\[\\[env\\.preview\\.r2_buckets\\]\\]/ s|^R2E_UPLOAD_ALLOWED_ORIGINS = \".*\"$|R2E_UPLOAD_ALLOWED_ORIGINS = \"$(escape_sed_replacement "${upload_allowed_origins_preview}")\"|g" \
    -e "/^\\[env\\.preview\\.vars\\]/,/^\\[\\[env\\.preview\\.r2_buckets\\]\\]/ s|^R2E_UPLOAD_S3_BUCKET = \".*\"$|R2E_UPLOAD_S3_BUCKET = \"$(escape_sed_replacement "${upload_s3_bucket_preview}")\"|g" \
    -e "s|R2E_BUCKET_MAP = \"\"|R2E_BUCKET_MAP = \"${escaped_bucket_map}\"|g" \
    "${template_path}" >"${output_path}"

  if grep -q "replace-with-" "${output_path}"; then
    echo "Error: unresolved placeholder remains in ${output_path}" >&2
    exit 1
  fi
}

main "$@"
