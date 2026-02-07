#!/usr/bin/env bash
set -euo pipefail

FLAKE_ATTR=".#r2"
OUT_FILE="r2-out-path.txt"
IMPORT_DIR="nix-export"

print_usage() {
  cat <<'EOF'
Usage: ./scripts/ci/ensure-r2-output.sh [--flake-attr <attr>] [--out-file <path>] [--import-dir <path>]

Ensures the requested flake output path exists locally by trying, in order:
1. Existing local store path from out-file.
2. Import from a file-store export directory.
3. Fallback local build.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
  --flake-attr)
    if [[ $# -lt 2 || -z ${2} ]]; then
      echo "--flake-attr requires a non-empty value." >&2
      exit 1
    fi
    FLAKE_ATTR="$2"
    shift 2
    ;;
  --out-file)
    if [[ $# -lt 2 || -z ${2} ]]; then
      echo "--out-file requires a non-empty value." >&2
      exit 1
    fi
    OUT_FILE="$2"
    shift 2
    ;;
  --import-dir)
    if [[ $# -lt 2 || -z ${2} ]]; then
      echo "--import-dir requires a non-empty value." >&2
      exit 1
    fi
    IMPORT_DIR="$2"
    shift 2
    ;;
  -h | --help)
    print_usage
    exit 0
    ;;
  *)
    echo "Unknown argument: $1" >&2
    print_usage >&2
    exit 1
    ;;
  esac
done

has_store_path() {
  local path="$1"
  nix path-info "$path" >/dev/null 2>&1
}

read_out_path() {
  if [[ -s $OUT_FILE ]]; then
    head -n 1 "$OUT_FILE"
  fi
}

out_path="$(read_out_path || true)"
reason=""

if [[ -n ${out_path} ]] && has_store_path "${out_path}"; then
  reason="existing"
fi

if [[ -z ${reason} ]] && [[ -n ${out_path} ]] && [[ -d ${IMPORT_DIR} ]]; then
  import_uri="file://$PWD/${IMPORT_DIR}"
  echo "Attempting to import ${out_path} from ${import_uri}"
  if nix copy --from "${import_uri}" "${out_path}"; then
    if has_store_path "${out_path}"; then
      reason="imported"
    fi
  fi
fi

if [[ -z ${reason} ]]; then
  echo "Prepared output unavailable; building ${FLAKE_ATTR}."
  nix build "${FLAKE_ATTR}"
  out_path="$(nix path-info "${FLAKE_ATTR}")"
  reason="rebuilt"
fi

printf '%s\n' "${out_path}" >"${OUT_FILE}"
nix path-info "${out_path}" >/dev/null
echo "Resolved output (${reason}): ${out_path}"
