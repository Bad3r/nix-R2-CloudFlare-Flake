# Cloudflare Access Routing Runbook

## Purpose

Keep the Cloudflare Access routing split aligned with the R2-Explorer contract:

- `/api/v2/*` remains Access-protected.
- `/share/*` remains public token download.

## When to Use

- Initial setup of R2-Explorer custom domains.
- Access policy drift correction.
- Recovery from unexpected public/private route exposure.

## Prerequisites

- Access to Cloudflare Access app and policy configuration.
- Worker deployed on `files.unsigned.sh` (or equivalent domain).
- At least one valid share token for validation.
- Valid Access service token credentials for API validation.

## Inputs / Environment Variables

- Target domain, example: `files.unsigned.sh`
- `R2E_ACCESS_AUD`
- Access service token client ID used by smoke probes
- Existing share token ID for public path verification

## Procedure (CLI-first)

1. Confirm API and share routes are mapped to the API Worker:
   - `files.unsigned.sh/api/v2/*`
   - `files.unsigned.sh/share/*`
   - `preview.files.unsigned.sh/api/v2/*`
   - `preview.files.unsigned.sh/share/*`

2. Validate Access apps and policies:
   - `/api/v2/*` app has an `allow` policy and a `Service Auth` policy.
   - `/api/v2/*` app has no `bypass` policy.
   - `/share/*` app has a `bypass` policy.

3. Run the contract checker:

```bash
export CLOUDFLARE_API_TOKEN="<api-token>"
export CLOUDFLARE_ACCOUNT_ID="<account-id>"
./scripts/ci/check-r2-access-policy.sh \
  files.unsigned.sh \
  "<expected-api-aud>" \
  "<service-token-client-id>"
```

4. Validate protected API routes without identity:

```bash
curl -i https://files.unsigned.sh/api/v2/session/info
curl -i https://preview.files.unsigned.sh/api/v2/session/info
```

Expected: `302` to Access login or `401 access_required`.

5. Validate protected API routes with service-token headers:

```bash
curl -i \
  -H "CF-Access-Client-Id: <client-id>" \
  -H "CF-Access-Client-Secret: <client-secret>" \
  https://files.unsigned.sh/api/v2/session/info
```

6. Validate public token route:

```bash
curl -I https://files.unsigned.sh/share/<token-id>
curl -I https://preview.files.unsigned.sh/share/<token-id>
```

## Verification

- `/api/v2/*` denies unauthenticated requests (`302` login redirect or `401 access_required`).
- `/api/v2/*` accepts valid Access service-token credentials.
- `/share/<token-id>` remains reachable without API authentication and enforces token validity.
- `/api/v2/share/*` remains Access-protected and scope-gated when configured.

## Failure Signatures and Triage

- `/share/*` unexpectedly requires auth:
  - share Access app lost bypass policy.
- `/api/v2/*` unexpectedly public:
  - API Access app missing protection or has bypass policy.
- `/api/v2/*` returns `token_invalid_signature` globally:
  - Access JWKS/cert endpoint or verifier config outage.
- `/api/v2/*` returns `token_claim_mismatch`:
  - Access AUD mismatch between app and Worker config.

## Rollback / Recovery

1. Restore previous known-good Worker deployment and env snapshot.
2. Restore previous known-good Access app/policy configuration.
3. Re-run Access contract and protected/public path checks.
4. Audit recent Access app/policy changes.

## Post-incident Notes

- Record changed Access apps/policies and timestamps.
- Record env values before/after (`R2E_ACCESS_TEAM_DOMAIN`, `R2E_ACCESS_AUD`, `R2E_ACCESS_JWKS_URL`).
- Capture failing and restored request/response evidence.
