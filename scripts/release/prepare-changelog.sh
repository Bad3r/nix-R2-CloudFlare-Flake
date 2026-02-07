#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/release/prepare-changelog.sh --version <X.Y.Z> [--file <path>] [--date <YYYY-MM-DD>]

Promotes the current [Unreleased] section into a versioned release section and
resets [Unreleased] to an empty template.
USAGE
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

version=""
file="CHANGELOG.md"
release_date="$(date -u +%Y-%m-%d)"

while [[ $# -gt 0 ]]; do
  case "$1" in
  --version)
    [[ $# -ge 2 ]] || fail "--version requires a value"
    version="$2"
    shift 2
    ;;
  --file)
    [[ $# -ge 2 ]] || fail "--file requires a value"
    file="$2"
    shift 2
    ;;
  --date)
    [[ $# -ge 2 ]] || fail "--date requires a value"
    release_date="$2"
    shift 2
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    fail "Unknown argument: $1"
    ;;
  esac
done

[[ -n ${version} ]] || fail "--version is required"
[[ -f ${file} ]] || fail "Changelog file not found: ${file}"

if [[ ! ${version} =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "Invalid version '${version}'. Expected strict semver X.Y.Z without leading 'v'."
fi

if [[ ! ${release_date} =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  fail "Invalid --date '${release_date}'. Expected YYYY-MM-DD."
fi

if grep -Eq "^## \[v${version}\] - " "${file}"; then
  fail "Version section already exists for v${version} in ${file}"
fi

unreleased_line="$(awk '/^## \[Unreleased\]$/ { print NR; exit }' "${file}")"
[[ -n ${unreleased_line} ]] || fail "Missing required heading: ## [Unreleased]"

total_lines="$(wc -l <"${file}")"
next_heading_line="$(awk -v start="$((unreleased_line + 1))" 'NR >= start && /^## \[/ { print NR; exit }' "${file}")"
if [[ -z ${next_heading_line} ]]; then
  next_heading_line="$((total_lines + 1))"
fi

unreleased_start="$((unreleased_line + 1))"
unreleased_end="$((next_heading_line - 1))"

if ((unreleased_start > total_lines || unreleased_end < unreleased_start)); then
  fail "[Unreleased] section in ${file} is empty or malformed"
fi

if ! sed -n "${unreleased_start},${unreleased_end}p" "${file}" | grep -Eq '[[:alnum:]]'; then
  fail "[Unreleased] section in ${file} has no release content"
fi

tmp_file="$(mktemp "${TMPDIR:-/tmp}/prepare-changelog.XXXXXX")"
cleanup() {
  rm -f "${tmp_file}"
}
trap cleanup EXIT

sed -n "1,${unreleased_line}p" "${file}" >"${tmp_file}"
cat >>"${tmp_file}" <<EOF_TEMPLATE

### Added

- _No changes yet._

### Changed

- _No changes yet._

### Fixed

- _No changes yet._

## [v${version}] - ${release_date}
EOF_TEMPLATE

sed -n "${unreleased_start},${unreleased_end}p" "${file}" >>"${tmp_file}"

if ((next_heading_line <= total_lines)); then
  sed -n "${next_heading_line},${total_lines}p" "${file}" >>"${tmp_file}"
fi

mv "${tmp_file}" "${file}"
trap - EXIT

echo "Prepared ${file} for release v${version} (${release_date})."
