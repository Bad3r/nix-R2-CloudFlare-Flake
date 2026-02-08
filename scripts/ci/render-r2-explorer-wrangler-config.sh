#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name="$1"
  if [[ -z ${!name:-} ]]; then
    echo "Error: required environment variable is missing: ${name}" >&2
    exit 1
  fi
}

escape_sed_replacement() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
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

  sed \
    -e "s|replace-with-r2-bucket-preview|$(escape_sed_replacement "${R2E_FILES_BUCKET_PREVIEW}")|g" \
    -e "s|replace-with-r2-bucket|$(escape_sed_replacement "${R2E_FILES_BUCKET}")|g" \
    -e "s|replace-with-shares-kv-namespace-id-preview|$(escape_sed_replacement "${R2E_SHARES_KV_ID_PREVIEW}")|g" \
    -e "s|replace-with-shares-kv-namespace-id|$(escape_sed_replacement "${R2E_SHARES_KV_ID}")|g" \
    -e "s|replace-with-keys-kv-namespace-id-preview|$(escape_sed_replacement "${R2E_KEYS_KV_ID_PREVIEW}")|g" \
    -e "s|replace-with-keys-kv-namespace-id|$(escape_sed_replacement "${R2E_KEYS_KV_ID}")|g" \
    "${template_path}" >"${output_path}"

  if grep -q "replace-with-" "${output_path}"; then
    echo "Error: unresolved placeholder remains in ${output_path}" >&2
    exit 1
  fi
}

main "$@"
