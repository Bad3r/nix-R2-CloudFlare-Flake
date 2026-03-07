# Deploy Flows and Preview Smoke Tests

This page describes deploy-time verification in CI.
Preview includes smoke/live tests. Production is deploy-only.

## Preview flow

1. Render worker config.
2. Verify Access policy contract on `preview.files.unsigned.sh` API host.
3. Run worker typecheck/tests and web build.
4. Sync worker secrets and upload CORS.
5. Conditionally sync preview CSP rule.
6. Deploy preview API and web workers.
7. Run smoke and live integration checks.

## Production flow (deploy-only)

1. Enforce `ref=main`.
2. Validate required deploy configuration.
3. Render worker config.
4. Install dependencies and build web bundle.
5. Sync CSP and upload CORS.
6. Deploy production API and web workers.

## Key scripts (used by preview verification)

- `scripts/ci/check-r2-access-policy.sh`
- `scripts/ci/check-r2-web-security.sh`
- `scripts/ci/worker-share-smoke.sh`

## Commands

```bash
./scripts/ci/check-r2-access-policy.sh <host> <expected-aud> <service-token-client-id>
./scripts/ci/check-r2-web-security.sh <base-url> r2-explorer/web/config/csp.analytics.production.txt
./scripts/ci/worker-share-smoke.sh
```

## Preview smoke environment contract

Preview smoke keys:

- `CF_PREVIEW_CI_SMOKE_BASE_URL`
- `CF_PREVIEW_CI_SMOKE_BUCKET`
- `CF_PREVIEW_CI_SMOKE_KEY`
- `CF_PREVIEW_CI_SERVICE_TOKEN_CLIENT_ID`
- `CF_PREVIEW_CI_SERVICE_TOKEN_CLIENT_SECRET`

Production deploy in CI does not require `CF_PRODUCTION_CI_*` smoke/service-token keys.

## References

- Google developer documentation style guide: <https://developers.google.com/style>
- Cloudflare Access policies: <https://developers.cloudflare.com/cloudflare-one/access-controls/policies/>
- Cloudflare Access service tokens: <https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/>
