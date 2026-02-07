#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/release/generate-release-notes.sh --version <X.Y.Z> [--file <path>]

Prints the release-notes markdown for the requested version from the changelog.
USAGE
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

version=""
file="CHANGELOG.md"

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

heading_line="$(awk -v needle="## [v${version}] - " 'index($0, needle) == 1 { print NR; exit }' "${file}")"
[[ -n ${heading_line} ]] || fail "Could not find release heading for v${version} in ${file}"

total_lines="$(wc -l <"${file}")"
next_heading_line="$(awk -v start="$((heading_line + 1))" 'NR >= start && /^## \[/ { print NR; exit }' "${file}")"
if [[ -z ${next_heading_line} ]]; then
  next_heading_line="$((total_lines + 1))"
fi

section_start="$((heading_line + 1))"
section_end="$((next_heading_line - 1))"

if ((section_end < section_start)); then
  fail "Release section for v${version} has no body"
fi

if ! sed -n "${section_start},${section_end}p" "${file}" | grep -Eq '[[:alnum:]]'; then
  fail "Release section for v${version} has no textual content"
fi

sed -n "${section_start},${section_end}p" "${file}"
