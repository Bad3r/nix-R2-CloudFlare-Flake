# R2 Explorer Web UI

Astro + React frontend for the R2 Explorer operator console.

## Local dev

```bash
pnpm -C .. install --frozen-lockfile
pnpm dev
```

The UI expects the API Worker to be reachable on the same origin under `/api/v2/*`.

## Validate

```bash
pnpm check
pnpm build
```
