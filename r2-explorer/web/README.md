# R2 Explorer Web UI

Astro + Preact frontend for the R2 Explorer operator console.

## Local dev

```bash
pnpm -C .. install --frozen-lockfile
pnpm dev
```

The UI expects the API Worker to be reachable on the same origin under
`/api/v2/*` and `/share/*`.

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
