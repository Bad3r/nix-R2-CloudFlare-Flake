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
   - App A (protected): `files.unsigned.sh/*` with policy action `Allow` for
     trusted identities.
   - App B (public download bypass): `files.unsigned.sh/share/*` with policy
     action `Bypass`.
   - App C (HMAC admin bypass): `files.unsigned.sh/api/share/*` with policy
     action `Bypass`.

2. Confirm the more-specific bypass apps (`/share/*` and `/api/share/*`) take
   precedence over the broad `/*` app.

3. Validate protected root and API routes (should redirect to Access login when
   unauthenticated):

```bash
curl -I https://files.unsigned.sh/
curl -I https://files.unsigned.sh/api/list
```

4. Validate public token route (no Access redirect):

```bash
curl -I https://files.unsigned.sh/share/<token-id>
```

5. Validate Worker share-management works without an Access browser session:

```bash
r2 share worker create files workspace/demo.txt 10m --max-downloads 1
```

## Verification

- `/api/*` requires Access-authenticated session.
- `/share/<token-id>` is reachable without Access membership and still enforces
  token validity.
- `/api/share/*` is reachable without Access membership but still requires
  Worker admin HMAC (or Access JWT) and should not become public `200`.
- Worker is configured with `R2E_ACCESS_TEAM_DOMAIN` and `R2E_ACCESS_AUD`, and
  `/api/*` rejects invalid or missing Access JWT assertions.

## Failure Signatures and Triage

- `/share/*` redirects to Access login:
  - bypass policy missing, disabled, or lower precedence than broad rule.
- `r2 share worker create` fails with `HTTP 302`:
  - `/api/share/*` bypass is missing, so Access is intercepting HMAC traffic.
- `/api/*` is publicly reachable:
  - broad access policy too permissive or bypass too broad.
- Mixed behavior across clients:
  - stale DNS/session/cache state; retest with clean session.

## Rollback / Recovery

1. Reapply last known-good policy pair:
   - `/*` allow for org identities.
   - `/share/*` bypass only.
2. Re-run both curl checks for protected and public path behavior.
3. Audit policy edits and actor history in Cloudflare account logs.

## Post-incident Notes

- Record policy IDs, order, and change timestamp.
- Document blast radius and any temporarily exposed paths.
