# R2 Explorer Web UI

Astro + Preact frontend for the R2 Explorer operator console.

## Local dev

```bash
pnpm -C .. install --frozen-lockfile
pnpm dev
```

The UI expects the API Worker to be reachable on the same origin under
`/api/v2/*` and `/share/*`. `astro dev` alone only serves the UI; it has no
route for those paths, so every API call 404s against Astro itself.

### Two-terminal flow against a local API Worker

```bash
# terminal 1, from r2-explorer/
pnpm dev

# terminal 2, from r2-explorer/web/
pnpm dev
```

`astro.config.mjs` proxies `/api` and `/share` to `http://127.0.0.1:8787`
(wrangler's default `wrangler dev` port) so both dev servers run without a
route-split host.

This only fully works for `/share/*`: the token download route needs no
authentication. `/api/v2/*` is authenticated in-worker against a real
Cloudflare Access JWT (see `../README.md`'s Access auth model). A bare
`wrangler dev` process has no Access edge in front of it and there is no
dev-mode bypass, so every `/api/v2/*` call 401s with `access_required`
through the proxy. That is a real, correctly-shaped response, useful for
exercising the sign-in gate and routing changes, not a working authenticated
session.

To exercise authenticated routes:

- Deploy to preview (`nix run .#deploy` and `nix run .#deploy-web`, or let CI
  deploy on merge) and use `https://preview.files.unsigned.sh`, signing in
  through Cloudflare Access normally.
- For API route logic without the UI or real Access, use the API Worker's own
  test suite (`pnpm -C .. test:api`), which mocks Access JWT verification.

Deploy preview with same-host route split on
`https://preview.files.unsigned.sh`:

- web worker catches `/*`
- api worker claims `/api/v2/*` and `/share/*`

Separate `*.workers.dev` hosts for web and API are not supported by this UI
contract.

## Validate

```bash
pnpm check
pnpm build
```
