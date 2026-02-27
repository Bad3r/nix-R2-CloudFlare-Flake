# OAuth Credential and JWKS Rotation Runbook

## Purpose

Rotate machine OAuth client credentials and (when required) OAuth signing keys
used for `r2 share worker ...` automation, without interrupting share
management operations.

## When to Use

- Scheduled credential rotation.
- Suspected client secret exposure.
- Suspected signing key compromise.
- Operator handoff or boundary changes.

## Prerequisites

- `wrangler` and `r2` are installed.
- You can deploy `r2-explorer`.
- You can update secrets/env used by CLI automation.
- You can rotate client secrets and signing keys at the OAuth provider.

## Inputs / Environment Variables

- `R2_EXPLORER_BASE_URL`
- `R2_EXPLORER_OAUTH_TOKEN_URL`
- `R2_EXPLORER_OAUTH_CLIENT_ID`
- `R2_EXPLORER_OAUTH_CLIENT_SECRET`
- Worker validation config:
  - `R2E_AUTH_ISSUER`
  - `R2E_AUTH_AUDIENCE`
  - `R2E_AUTH_JWKS_URL`

## Procedure (CLI-first)

1. Export existing values for rollback reference:

```bash
export OLD_CLIENT_ID="${R2_EXPLORER_OAUTH_CLIENT_ID}"
export OLD_CLIENT_SECRET="${R2_EXPLORER_OAUTH_CLIENT_SECRET}"
```

2. Rotate client secret in your OAuth provider (or create a replacement
   client with equivalent scopes).
3. Update deployment secret source (SOPS/CI variables) with new
   `R2_EXPLORER_OAUTH_CLIENT_SECRET` (and client ID when replaced).
4. If signing-key rotation is required, rotate keys in OAuth provider and keep
   overlap until Worker validation succeeds with newly issued tokens.
5. Deploy Worker config update if issuer/audience/jwks values changed:

```bash
cd r2-explorer
wrangler deploy
```

6. Validate worker-share lifecycle calls:

```bash
r2 share worker create files documents/test.txt 1h --max-downloads 1
r2 share worker list files documents/test.txt
```

7. End overlap window:
   - Disable old client secret.
   - Remove retired signing keys from issuer JWKS after confirmation that no
     required callers still depend on them.

## Verification

- `r2 share worker create` succeeds with the new client credentials.
- `r2 share worker list` returns expected records.
- Tokens signed with retired keys are rejected after overlap removal.

## Failure Signatures and Triage

- `401 oauth_token_invalid`:
  - signing key mismatch, wrong issuer/audience, or stale JWKS endpoint.
- `401 oauth_required`:
  - token fetch failed or CLI env missing `R2_EXPLORER_OAUTH_*`.
- `403 insufficient_scope`:
  - client token missing `R2E_AUTH_SCOPE_SHARE_MANAGE`.

## Rollback / Recovery

1. Restore previous client secret in your secret source:

```bash
export R2_EXPLORER_OAUTH_CLIENT_ID="${OLD_CLIENT_ID}"
export R2_EXPLORER_OAUTH_CLIENT_SECRET="${OLD_CLIENT_SECRET}"
```

2. Re-enable previous signing key in OAuth provider if rotation caused outage.
3. Redeploy Worker if validation config changed.
4. Re-run lifecycle verification commands.

## Post-incident Notes

- Record rotation timestamp, operator, and retired client/key IDs.
- Document overlap duration and reason for emergency vs scheduled rotation.
