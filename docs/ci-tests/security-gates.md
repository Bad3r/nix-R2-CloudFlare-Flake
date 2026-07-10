# Security Gates

CI enforces dependency and policy checks for root and worker surfaces.

## CI jobs

- `security-dependency-audit`
- `security-sensitive-change-policy`

## Security checks

- flake input policy scan via `flake-checker`
- JS dependency audit via `pnpm audit --audit-level=high`
- sensitive-file label gate for workflow and lockfile edits (trusted PR
  authors bypass the label; see the `trusted-actors` input in
  `.github/actions/security-sensitive-change-policy/action.yml`)

## Local commands

```bash
nix run nixpkgs#flake-checker -- --no-telemetry --fail-mode --check-outdated --check-owner --check-supported flake.lock
pnpm -C r2-explorer audit --audit-level=high
```

## Remediation

1. Reproduce the failing gate locally.
2. Patch dependency/config changes in source-of-truth files.
3. Re-run the same gate command.

## References

- Google developer documentation style guide: <https://developers.google.com/style>
- GitHub Actions security docs: <https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions>
