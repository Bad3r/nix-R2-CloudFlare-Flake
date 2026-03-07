# Worker Test Suites

This page documents worker test coverage and required runtime inputs for live checks.

## Test files

| File                                         | Coverage                                    |
| -------------------------------------------- | ------------------------------------------- |
| `r2-explorer/tests/auth.spec.ts`             | Access auth and token validation behaviors  |
| `r2-explorer/tests/readonly.spec.ts`         | readonly mode enforcement                   |
| `r2-explorer/tests/share.spec.ts`            | share create/list/revoke lifecycle          |
| `r2-explorer/tests/multipart.spec.ts`        | multipart init/sign/complete/abort behavior |
| `r2-explorer/tests/server-info.spec.ts`      | `/api/v2/session/info` and response shape   |
| `r2-explorer/tests/web-api-retry.spec.ts`    | client retry behavior against API responses |
| `r2-explorer/tests/live.integration.spec.ts` | real-host smoke integration (no mocks)      |

## Commands

```bash
pnpm -C r2-explorer run check
pnpm -C r2-explorer run test:api
```

Live integration (requires real environment credentials):

```bash
pnpm -C r2-explorer run test:live
```

## Live-test environment contract

CI live tests read the preview environment family:

- `CF_PREVIEW_CI_*`

Required preview keys:

- `CF_PREVIEW_CI_SMOKE_BASE_URL`
- `CF_PREVIEW_CI_SMOKE_BUCKET`
- `CF_PREVIEW_CI_SMOKE_KEY`
- `CF_PREVIEW_CI_SERVICE_TOKEN_CLIENT_ID`
- `CF_PREVIEW_CI_SERVICE_TOKEN_CLIENT_SECRET`

Optional keys:

- `CF_PREVIEW_CI_R2_BIN`
- `CF_PREVIEW_CI_SMOKE_TTL`
- `CF_PREVIEW_CI_SMOKE_RETRIES`

Production CI does not run live tests and does not require `CF_PRODUCTION_CI_*`
smoke/service-token keys.

## References

- Google developer documentation style guide: <https://developers.google.com/style>
- Cloudflare Access service tokens: <https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/>
