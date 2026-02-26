#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Error: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:
  sync-r2-upload-cors.sh <bucket-name> <allowed-origins-csv> <base-url>

Arguments:
  bucket-name          Target R2 bucket name used for signed multipart uploads.
  allowed-origins-csv  Optional comma-separated origins/URLs to include in CORS.
  base-url             Required deployed host URL; its origin is always allowed.
USAGE
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -ne 3 ]]; then
  usage >&2
  fail "expected 3 arguments, got $#"
fi

bucket_name="$1"
allowed_origins_csv="$2"
base_url="$3"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "${script_dir}/../.." && pwd -P)"
worker_dir="${repo_root}/r2-explorer"

if [[ -z ${bucket_name} ]]; then
  fail "bucket name must not be empty"
fi

if [[ -z ${base_url} ]]; then
  fail "base URL must not be empty"
fi

if [[ ! -f "${worker_dir}/package.json" ]]; then
  fail "r2-explorer workspace not found at ${worker_dir}"
fi

for required in node jq pnpm; do
  if ! command -v "${required}" >/dev/null 2>&1; then
    fail "required command not found: ${required}"
  fi
done

origins_json="$(
  node - "${allowed_origins_csv}" "${base_url}" <<'NODE'
const csv = process.argv[2] ?? "";
const baseUrl = process.argv[3] ?? "";

function normalizeOrigin(value, label) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} is not a valid URL: ${trimmed}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http or https: ${trimmed}`);
  }

  return parsed.origin;
}

const resolved = new Set();
const baseOrigin = normalizeOrigin(baseUrl, "base URL");
if (!baseOrigin) {
  throw new Error("base URL is required");
}
resolved.add(baseOrigin);

for (const rawEntry of csv.split(",")) {
  const origin = normalizeOrigin(rawEntry, "allowed origin");
  if (origin) {
    resolved.add(origin);
  }
}

if (resolved.size === 0) {
  throw new Error("no upload CORS origins resolved");
}

process.stdout.write(JSON.stringify([...resolved]));
NODE
)" || fail "failed to resolve upload CORS origins"

cors_file="$(mktemp "${TMPDIR:-/tmp}/r2-upload-cors.XXXXXX.json")"
cleanup() {
  rm -f "${cors_file}"
}
trap cleanup EXIT

jq -n --argjson origins "${origins_json}" '
{
  rules: [
    {
      allowed: {
        origins: $origins,
        methods: ["PUT", "GET", "HEAD"],
        headers: ["content-type", "content-length", "content-md5"]
      },
      exposeHeaders: ["ETag"],
      maxAgeSeconds: 3600
    }
  ]
}
' >"${cors_file}"

echo "Syncing upload CORS for bucket '${bucket_name}' with origins: ${origins_json}"
pnpm --dir "${worker_dir}" exec wrangler r2 bucket cors set "${bucket_name}" --file "${cors_file}" --force
echo "Upload CORS sync complete for bucket '${bucket_name}'."
