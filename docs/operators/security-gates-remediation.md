# Security Gates Remediation

## Purpose

Provide a repeatable remediation workflow when CI security and supply-chain
gates fail.

## Gates Covered

- Dependency audit gate (`security-dependency-audit`):
  - `pnpm audit --audit-level=high` for `r2-explorer`
  - `vulnix` scan for the built `.#r2` Nix closure
  - baseline allowlist: `scripts/ci/vulnix-whitelist.toml`
- Secret scanning gate:
  - `ripsecrets` in `lefthook` pre-commit jobs
  - CI enforcement through `lefthook run pre-commit --all-files`
- Sensitive change policy gate (`security-sensitive-change-policy`):
  - lockfile/workflow changes require `security-review-approved` label
  - CODEOWNER review required by branch protection

## Prerequisites

- `nix`, `pnpm`, and `gh` installed.
- Repo checkout on the failing commit/PR branch.
- Permission to apply labels and request reviews on the PR.

## Procedure

1. Identify the failing gate from CI checks.
2. Reproduce locally with the same command:

```bash
./scripts/ci/validate.sh --target root-format-lint
cd r2-explorer && pnpm install --frozen-lockfile && pnpm audit --audit-level=high
nix build .#r2
nix run nixpkgs#vulnix -- -C "$(nix path-info .#r2)" -w ./scripts/ci/vulnix-whitelist.toml
```

3. Apply targeted remediation:
   - For `pnpm audit` findings:
     - upgrade or replace vulnerable dependencies
     - regenerate `r2-explorer/pnpm-lock.yaml` and rerun audit
   - For `vulnix` findings:
     - update pinned flake inputs (`flake.lock`, `r2-explorer/flake.lock`)
     - rebuild and rerun `vulnix`
     - if risk acceptance is required, update
       `scripts/ci/vulnix-whitelist.toml` in the same PR with justification
   - For `ripsecrets` findings:
     - remove committed secret material and rotate leaked credentials
     - if false positive, add scoped ignore entries to `.secretsignore`
   - For sensitive change policy failures:
     - add label `security-review-approved`
     - request and obtain CODEOWNER approval (`@Bad3r`)
4. Re-run local checks and push fixes.
5. Confirm all required checks are green before merge.

## Failure Signatures

- `pnpm audit` exits non-zero with high/critical vulnerabilities.
- `vulnix` reports non-empty results for closure CVEs.
- `ripsecrets` reports potential secret patterns in changed files.
- Policy check reports changed sensitive files and missing required label.

## Escalation

- If a vulnerability has no immediate patch, open a tracked risk exception in
  the PR with:
  - impacted component
  - exploitability assessment
  - compensating controls
  - planned remediation date
- If active credential leakage is suspected, follow
  `docs/operators/incident-response.md` and rotate credentials immediately.
