#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

REPO_URL="https://github.com/Bad3r/nix-R2-CloudFlare-Flake"
WIKI_REMOTE="${REPO_URL%.git}.wiki.git"
COMMIT_SHA="$(git rev-parse --short HEAD)"
DOCS_DIR="${REPO_ROOT}/docs"
WIKI_DIR="$(mktemp -d)"

trap 'rm -rf "${WIKI_DIR}"' EXIT

# ---------------------------------------------------------------------------
# Clone wiki repository
# ---------------------------------------------------------------------------
echo "Cloning wiki repository..."
if ! git clone --depth 1 \
  --config "http.${WIKI_REMOTE}/.extraheader=Authorization: basic $(printf 'x-access-token:%s' "${GITHUB_TOKEN}" | base64)" \
  "${WIKI_REMOTE}" "${WIKI_DIR}" 2>/dev/null; then
  echo "ERROR: Failed to clone wiki repository."
  echo "Ensure the wiki is initialized: create one page via the GitHub UI first."
  exit 1
fi

# ---------------------------------------------------------------------------
# Clear existing wiki content (preserve .git/)
# ---------------------------------------------------------------------------
find "${WIKI_DIR}" -maxdepth 1 -not -name '.git' -not -path "${WIKI_DIR}" -exec rm -rf {} +

# ---------------------------------------------------------------------------
# File mapping: source path (relative to DOCS_DIR) -> wiki filename (no .md)
# Plan docs (`docs/plan.md` and `docs/plan/**`) are intentionally excluded from
# wiki sync.
# ---------------------------------------------------------------------------
declare -A FILE_MAP=(
  # Top-level guides
  ["quickstart.md"]="Quickstart"
  ["credentials.md"]="Credentials"
  ["sharing.md"]="Sharing"
  ["sync.md"]="Sync"
  ["troubleshooting.md"]="Troubleshooting"
  ["versioning.md"]="Versioning"

  # Operator runbooks
  ["operators/index.md"]="Operators"
  ["operators/key-rotation.md"]="Operators-Key-Rotation"
  ["operators/readonly-maintenance.md"]="Operators-Readonly-Maintenance"
  ["operators/access-policy-split.md"]="Operators-Access-Policy-Split"
  ["operators/incident-response.md"]="Operators-Incident-Response"
  ["operators/rollback-worker-share.md"]="Operators-Rollback-Worker-Share"
  ["operators/security-gates-remediation.md"]="Operators-Security-Gates-Remediation"

  # Option reference
  ["reference/index.md"]="Reference"
  ["reference/programs-git-annex-r2.md"]="Reference-programs-git-annex-r2"
  ["reference/programs-r2-cloud.md"]="Reference-programs-r2-cloud"
  ["reference/programs-r2-cloud-credentials.md"]="Reference-programs-r2-cloud-credentials"
  ["reference/programs-r2-cloud-rclone-config.md"]="Reference-programs-r2-cloud-rclone-config"
  ["reference/services-r2-restic.md"]="Reference-services-r2-restic"
  ["reference/services-r2-sync.md"]="Reference-services-r2-sync"
)

# ---------------------------------------------------------------------------
# Helper: title-case an operator filename stem
#   key-rotation -> Key-Rotation
# ---------------------------------------------------------------------------
title_case_stem() {
  local stem="$1"
  echo "${stem}" | sed -E 's/(^|-)([a-z])/\1\u\2/g'
}

# ---------------------------------------------------------------------------
# Copy files into wiki directory
# ---------------------------------------------------------------------------
echo "Copying docs to wiki..."
for src in "${!FILE_MAP[@]}"; do
  if [[ ${src} == "plan.md" || ${src} == plan/* ]]; then
    echo "Skipping plan doc: docs/${src}"
    continue
  fi
  wiki_name="${FILE_MAP[${src}]}"
  if [[ ! -f "${DOCS_DIR}/${src}" ]]; then
    echo "WARNING: source file docs/${src} not found, skipping"
    continue
  fi
  cp "${DOCS_DIR}/${src}" "${WIKI_DIR}/${wiki_name}.md"
done

# ---------------------------------------------------------------------------
# Build sed substitution script for link rewriting
# ---------------------------------------------------------------------------
build_sed_script() {
  local sed_script=""

  # 1) Rewrite backtick references: `docs/<path>` -> [WikiTitle](WikiName)
  for src in "${!FILE_MAP[@]}"; do
    wiki_name="${FILE_MAP[${src}]}"
    # Extract display title from H1 of source file
    local display_title
    display_title="$(head -1 "${DOCS_DIR}/${src}" | sed 's/^# //')"
    # Escape special sed characters in the source path
    local escaped_src
    escaped_src="$(printf '%s' "docs/${src}" | sed 's/[.[\/*^$]/\\&/g')"
    sed_script+="s|\`${escaped_src}\`|[${display_title}](${wiki_name})|g;"
  done

  # 2) Rewrite backtick references to excluded plan files
  sed_script+='s|`docs/plan.md`|[Plan]('"${REPO_URL}"'/blob/main/docs/plan.md)|g;'
  sed_script+='s|`docs/plan/[^`]*`|[Plan]('"${REPO_URL}"'/tree/main/docs/plan)|g;'

  # 3) Rewrite relative links in operators/: (./foo.md) -> (Operators-Foo)
  for src in "${!FILE_MAP[@]}"; do
    if [[ ${src} == operators/* && ${src} != "operators/index.md" ]]; then
      local basename
      basename="$(basename "${src}" .md)"
      wiki_name="${FILE_MAP[${src}]}"
      sed_script+="s|(\\./${basename}\\.md)|(${wiki_name})|g;"
    fi
  done

  # 4) Rewrite relative links in reference/: (./foo.md) -> (Reference-foo)
  for src in "${!FILE_MAP[@]}"; do
    if [[ ${src} == reference/* && ${src} != "reference/index.md" ]]; then
      local basename
      basename="$(basename "${src}" .md)"
      wiki_name="${FILE_MAP[${src}]}"
      sed_script+="s|(\\./${basename}\\.md)|(${wiki_name})|g;"
    fi
  done

  echo "${sed_script}"
}

echo "Rewriting internal links..."
SED_SCRIPT="$(build_sed_script)"

for wiki_file in "${WIKI_DIR}"/*.md; do
  sed -i "${SED_SCRIPT}" "${wiki_file}"
done

# ---------------------------------------------------------------------------
# Generate Home.md (wiki landing page)
# ---------------------------------------------------------------------------
echo "Generating Home.md..."
cat >"${WIKI_DIR}/Home.md" <<'HOMEEOF'
# nix-R2-CloudFlare-Flake

## Getting Started

- [Quickstart](Quickstart) — Template-based bootstrap for sync-only and full setups
- [Credentials](Credentials) — Credential paths, environment variables, and secret file layout

## Guides

- [Sync](Sync) — rclone mount and bisync configuration
- [Versioning](Versioning) — restic snapshots and git-annex large file tracking
- [Sharing](Sharing) — Presigned URLs, Worker shares, and Access policy setup
- [Troubleshooting](Troubleshooting) — Diagnostic matrix for auth, sync, backup, and share failures

## Operator Runbooks

- [Operator Runbooks](Operators) — Index of all operational procedures
  - [Key Rotation](Operators-Key-Rotation)
  - [Readonly Maintenance](Operators-Readonly-Maintenance)
  - [Access Policy Split](Operators-Access-Policy-Split)
  - [Incident Response](Operators-Incident-Response)
  - [Rollback Worker/Share](Operators-Rollback-Worker-Share)
  - [Security Gates Remediation](Operators-Security-Gates-Remediation)

## Option Reference

- [Option Reference](Reference) — Index of all module option pages
  - [`services.r2-sync`](Reference-services-r2-sync)
  - [`services.r2-restic`](Reference-services-r2-restic)
  - [`programs.git-annex-r2`](Reference-programs-git-annex-r2)
  - [`programs.r2-cloud`](Reference-programs-r2-cloud)
  - [`programs.r2-cloud.credentials`](Reference-programs-r2-cloud-credentials)
  - [`programs.r2-cloud` rclone config](Reference-programs-r2-cloud-rclone-config)

---

> This wiki mirrors [`docs/`](https://github.com/Bad3r/nix-R2-CloudFlare-Flake/tree/main/docs). Edit source files in the main repository.
HOMEEOF

# ---------------------------------------------------------------------------
# Generate _Sidebar.md
# ---------------------------------------------------------------------------
echo "Generating _Sidebar.md..."
cat >"${WIKI_DIR}/_Sidebar.md" <<'SIDEBAREOF'
**Getting Started**

- [Quickstart](Quickstart)
- [Credentials](Credentials)

**Guides**

- [Sync](Sync)
- [Versioning](Versioning)
- [Sharing](Sharing)
- [Troubleshooting](Troubleshooting)

**Operator Runbooks**

- [Overview](Operators)
SIDEBAREOF

# Append operator runbook entries (auto-detected from wiki files)
for f in "${WIKI_DIR}"/Operators-*.md; do
  [[ -f ${f} ]] || continue
  basename_no_ext="$(basename "${f}" .md)"
  # Extract H1 heading for display text
  heading="$(head -1 "${f}" | sed 's/^# //')"
  echo "- [${heading}](${basename_no_ext})" >>"${WIKI_DIR}/_Sidebar.md"
done

cat >>"${WIKI_DIR}/_Sidebar.md" <<'SIDEBAREOF2'

**Option Reference**

- [Overview](Reference)
SIDEBAREOF2

# Append reference entries (auto-detected from wiki files)
for f in "${WIKI_DIR}"/Reference-*.md; do
  [[ -f ${f} ]] || continue
  basename_no_ext="$(basename "${f}" .md)"
  heading="$(head -1 "${f}" | sed 's/^# //')"
  echo "- [${heading}](${basename_no_ext})" >>"${WIKI_DIR}/_Sidebar.md"
done

# ---------------------------------------------------------------------------
# Commit and push if there are changes
# ---------------------------------------------------------------------------
cd "${WIKI_DIR}"
git add -A

if git diff --cached --quiet; then
  echo "No changes detected — wiki is already up to date."
  exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git commit -m "docs: sync from ${COMMIT_SHA}"
git push origin master

echo "Wiki synced successfully from ${COMMIT_SHA}."
