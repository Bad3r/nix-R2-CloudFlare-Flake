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
- Worker deployed on `files.example.com` (or equivalent domain).
- At least one valid share token for validation.

## Inputs / Environment Variables

- Target domain, example: `files.example.com`
- Access policy include rules for org users/groups
- Existing share token ID for public path verification

## Procedure (CLI-first)

1. Ensure two explicit Access policies exist for the same domain:
   - Policy A: path `/*`, action `Allow`, include org identities.
   - Policy B: path `/share/*`, action `Bypass`.
2. Confirm policy precedence evaluates `/share/*` with bypass before broad deny
   behavior.
3. Validate protected API route:

```bash
curl -I https://files.example.com/api/list
```

4. Validate public token route:

```bash
curl -I https://files.example.com/share/<token-id>
```

## Verification

- `/api/*` requires Access-authenticated session.
- `/share/<token-id>` is reachable without Access membership and still enforces
  token validity.

## Failure Signatures and Triage

- `/share/*` redirects to Access login:
  - bypass policy missing, disabled, or lower precedence than broad rule.
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
