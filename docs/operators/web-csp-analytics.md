# Web CSP + Analytics Runbook

## Purpose

Keep Cloudflare analytics enabled on the web console while enforcing a stable
CSP through IaC.

## Scope

- Host: `files.unsigned.sh`
- Preview host: `preview.files.unsigned.sh`
- Web routes only (`/*` excluding `/api/v2/*` and `/share/*`)

## Source of Truth

- CSP policy file:
  - `r2-explorer/web/config/csp.analytics.production.txt`
- Cloudflare sync script:
  - `scripts/ci/sync-r2-web-csp.sh`
- Runtime verification script:
  - `scripts/ci/check-r2-web-security.sh`

## Required Permissions

The API token used for CSP sync must include:

- `Zone Rulesets Write`
- `Zone Rulesets Read`

## GitHub Environment Variables

- Set `R2E_CF_ZONE_NAME` in both `preview` and `production` GitHub
  Environments.
- Preview: empty `R2E_CF_ZONE_NAME` is allowed; preview CSP sync/verification
  steps skip with explicit `::notice::` logs.
- Production: empty `R2E_CF_ZONE_NAME` is not allowed; deploy fails fast before
  CSP sync.

## CSP Rule Refs

- Production CSP rule ref: `r2-explorer-web-csp`
- Preview CSP rule ref: `r2-explorer-web-csp-preview`
- Keep refs distinct to avoid host-expression overwrite in the shared
  `http_response_headers_transform` phase entrypoint.

## Manual Apply

```bash
export CLOUDFLARE_API_TOKEN="..."
export R2E_CF_ZONE_NAME="unsigned.sh"

./scripts/ci/sync-r2-web-csp.sh \
  "files.unsigned.sh" \
  "r2-explorer/web/config/csp.analytics.production.txt"
```

Preview manual apply (distinct rule ref):

```bash
export CLOUDFLARE_API_TOKEN="..."
export R2E_CF_ZONE_NAME="unsigned.sh"
export R2E_WEB_CSP_RULE_REF="r2-explorer-web-csp-preview"
export R2E_WEB_CSP_RULE_DESCRIPTION="R2 Explorer web CSP (preview, analytics-enabled)"

./scripts/ci/sync-r2-web-csp.sh \
  "preview.files.unsigned.sh" \
  "r2-explorer/web/config/csp.analytics.production.txt"
```

## Verification

Use Access service-token headers to validate protected page behavior:

```bash
export R2E_SMOKE_ACCESS_CLIENT_ID="..."
export R2E_SMOKE_ACCESS_CLIENT_SECRET="..."

./scripts/ci/check-r2-web-security.sh \
  "https://files.unsigned.sh" \
  "r2-explorer/web/config/csp.analytics.production.txt"
```

Expected outcomes:

- Response CSP equals normalized policy content (comment and blank lines are ignored).
- HTML includes analytics loader markers (`/cdn-cgi/zaraz/` or
  `static.cloudflareinsights.com/beacon.min.js`).
- HTML does not include the empty-content sha512 marker associated with broken
  SRI fetches.

Preview workflow behavior:

- If preview host is in the configured zone (`R2E_CF_ZONE_NAME`), preview deploy
  syncs CSP and preview smoke verifies CSP/analytics markers.
- If preview host is outside the configured zone, CSP sync/verify steps are
  skipped with explicit `::notice::` logs.

## Failure Signatures and Triage

- `HTTP 403 request is not authorized` from sync script:
  - Token lacks `Zone Rulesets` permissions.
- CSP mismatch:
  - Rule drift in Cloudflare dashboard or wrong zone name/host expression.
- Analytics marker missing:
  - Web Analytics/Zaraz injection disabled or blocked by non-CSP controls.
- Empty-content sha512 marker detected:
  - Broken third-party fetch path (often CSP/CORS/network/intermediary issue).

## Rollback

1. Re-sync the previous known-good CSP policy file with the affected rule ref
   (`r2-explorer-web-csp` or `r2-explorer-web-csp-preview`).
2. Re-run `check-r2-web-security.sh`.
3. If still failing, remove only the affected CSP rule ref and restore the
   previous Cloudflare ruleset version from audit logs.
