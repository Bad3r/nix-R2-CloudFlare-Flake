# Access Policy Split Runbook

## Purpose

Ensure Cloudflare Access protects interactive/admin routes while allowing public
tokenized share downloads.

## When to Use

- Initial setup of R2-Explorer custom domain.
- Access policy drift correction.
- Recovery from unexpected public/private route exposure.

## Prerequisites

- Access to Cloudflare Access policy management for target domain.
- Worker deployed on `files.unsigned.sh` (or equivalent domain).
- At least one valid share token for validation.

## Inputs / Environment Variables

- Target domain, example: `files.unsigned.sh`
- Access policy include rules for org users/groups
- Existing share token ID for public path verification

## Procedure (CLI-first)

1. Ensure Access app coverage is split by path for the same hostname:
   - App A (production API): `files.unsigned.sh/api/v2/*` with:
     - `Allow` policy for trusted identities.
     - `Service Auth` policy for CI/service tokens.
   - App B (production public download): `files.unsigned.sh/share/*` with policy
     action `Bypass`.
   - App C (preview API): `preview.files.unsigned.sh/api/v2/*` with:
     - `Allow` policy for trusted identities.
     - `Service Auth` policy for preview CI/service tokens.
   - App D (preview public download): `preview.files.unsigned.sh/share/*` with
     policy action `Bypass`.

2. Confirm there are no stale API bypass apps:
   - `files.unsigned.sh/api/v2/share/*`
   - `files.unsigned.sh/api/share/*`
   - `r2-explorer-preview.exploit.workers.dev/api/*`

3. Validate protected API routes (should redirect to Access login when
   unauthenticated):

```bash
curl -I https://files.unsigned.sh/api/v2/list
curl -I https://preview.files.unsigned.sh/api/v2/list
```

4. Validate public token route (no Access redirect):

```bash
curl -I https://files.unsigned.sh/share/<token-id>
curl -I https://preview.files.unsigned.sh/share/<token-id>
```

5. Validate Service Auth on API route:

```bash
curl -i \
  -H "CF-Access-Client-Id: <service-token-client-id>" \
  -H "CF-Access-Client-Secret: <service-token-client-secret>" \
  https://files.unsigned.sh/api/v2/session/info

curl -i \
  -H "CF-Access-Client-Id: <preview-service-token-client-id>" \
  -H "CF-Access-Client-Secret: <preview-service-token-client-secret>" \
  https://preview.files.unsigned.sh/api/v2/session/info
```

6. Validate Worker share-management with service-token headers:

```bash
export R2_EXPLORER_ACCESS_CLIENT_ID="<service-token-client-id>"
export R2_EXPLORER_ACCESS_CLIENT_SECRET="<service-token-client-secret>"
r2 share worker create files workspace/demo.txt 10m --max-downloads 1
```

## Verification

- `/api/v2/*` requires Access-authenticated session.
- `/share/<token-id>` is reachable without Access membership and still enforces
  token validity.
- `/api/v2/share/*` is never an Access `Bypass` path.
- Worker is configured with `R2E_ACCESS_TEAM_DOMAIN` and `R2E_ACCESS_AUD`, and
  `/api/v2/*` rejects invalid or missing Access JWT assertions.
- Preview Worker is configured with `R2E_ACCESS_AUD_PREVIEW` matching the
  preview API app audience.

## Failure Signatures and Triage

- `/share/*` redirects to Access login:
  - bypass policy missing, disabled, or shadowed by another app rule.
- `r2 share worker create` fails with `HTTP 302` or `401`:
  - CLI request missing `R2_EXPLORER_ACCESS_CLIENT_ID` or
    `R2_EXPLORER_ACCESS_CLIENT_SECRET`.
  - Service token is not included by a `Service Auth` policy on `/api/v2/*`.
  - `R2E_ACCESS_AUD` / `R2E_ACCESS_AUD_PREVIEW` does not match app audience.
- `/api/v2/*` is publicly reachable:
  - API app missing, disabled, or host/path mismatch.
- Mixed behavior across clients:
  - stale DNS/session/cache state; retest with clean session.

## Rollback / Recovery

1. Reapply last known-good policy model per host:
   - `/api/v2/*` with `Allow` + `Service Auth`.
   - `/share/*` with `Bypass`.
2. Re-run both curl checks for protected and public path behavior.
3. Audit policy edits and actor history in Cloudflare account logs.

## Post-incident Notes

- Record policy IDs, order, and change timestamp.
- Document blast radius and any temporarily exposed paths.
