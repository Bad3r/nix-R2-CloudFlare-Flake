# Sharing

Phase 4 provides presigned URL sharing via the package-backed CLI.

## Presigned URLs (S3 endpoint)

Use the primary command:

```bash
r2 share <bucket> <key> [expiry]
```

Examples:

```bash
r2 share documents report.pdf
r2 share documents report.pdf 168h
```

Notes:

- URLs are generated against the R2 S3 endpoint, not Access-protected custom
  domain routes.
- Credentials are loaded from `R2_CREDENTIALS_FILE` (default:
  `~/.config/cloudflare/r2/env`).
- Required variables in the sourced credentials file:
  - `R2_ACCOUNT_ID` (or HM-injected `R2_DEFAULT_ACCOUNT_ID`)
  - `AWS_ACCESS_KEY_ID`
  - `AWS_SECRET_ACCESS_KEY`

## Access-protected links

Access-protected custom-domain share links remain part of the Worker flow in
Phase 5.
