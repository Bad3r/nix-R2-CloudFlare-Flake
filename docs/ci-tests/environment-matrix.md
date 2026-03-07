# Environment Matrix and Manual Parity Checklist

This page defines required environment keys and a manual parity process.

## Classification policy

- Store credentials and sensitive values in GitHub environment **secrets**.
- Store non-sensitive routing and metadata values in GitHub environment **vars**.
- Do not add automated parity checks in CI. Use the manual checklist in this page.

## Required preview secrets

- `CF_PREVIEW_CI_SMOKE_BASE_URL`
- `CF_PREVIEW_CI_SMOKE_BUCKET`
- `CF_PREVIEW_CI_SMOKE_KEY`
- `CF_PREVIEW_CI_SERVICE_TOKEN_CLIENT_ID`
- `CF_PREVIEW_CI_SERVICE_TOKEN_CLIENT_SECRET`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`

## Required production deploy secrets (no CI smoke/live keys)

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`

## Optional smoke-tuning vars

Preview:

- `CF_PREVIEW_CI_SMOKE_RETRIES`
- `CF_PREVIEW_CI_SMOKE_RETRY_DELAY_SEC`
- `CF_PREVIEW_CI_SMOKE_TIMEOUT_SEC`
- `CF_PREVIEW_CI_SMOKE_CONNECT_TIMEOUT_SEC`
- `CF_PREVIEW_CI_SMOKE_SHARE_EXHAUSTION_RETRIES`
- `CF_PREVIEW_CI_SMOKE_TTL`

## Local metadata keys (example placeholders)

These keys are documented for operator workflows and do not need to be CI gates:

```bash
CF_TEAM_NAME=repo
REDIRECT_URI=https://repo.cloudflareaccess.com/cdn-cgi/access/callback
CF_PREVIEW_CI_SERVICE_TOKEN_NAME=ci-tests-preview
CF_PREVIEW_CI_SERVICE_TOKEN_ID=<uuid>
CF_PREVIEW_CI_SERVICE_TOKEN_DURATION=8760h
```

## Manual parity checklist

Run these commands:

```bash
gh secret list --env preview --repo Bad3r/nix-R2-CloudFlare-Flake
gh variable list --env preview --repo Bad3r/nix-R2-CloudFlare-Flake
gh secret list --env production --repo Bad3r/nix-R2-CloudFlare-Flake
gh variable list --env production --repo Bad3r/nix-R2-CloudFlare-Flake
```

Then verify:

1. All required preview keys exist in `preview` environment.
2. All required production deploy keys exist in `production` environment.
3. `CF_PREVIEW_CI_SMOKE_BASE_URL` points to the preview host.
4. `CF_PRODUCTION_CI_*` smoke/service-token keys are not required by CI.

## References

- Google developer documentation style guide: <https://developers.google.com/style>
- GitHub Actions environments: <https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments>
- GitHub Actions secrets: <https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions>
