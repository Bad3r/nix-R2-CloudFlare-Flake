# Security Gates Remediation

## Purpose

Provide a repeatable remediation workflow when CI security and supply-chain
gates fail.

## Gates Covered

- Dependency audit gate (`security-dependency-audit`):
  - `flake-checker` lock/input policy checks for:
    - `flake.lock`
    - `r2-explorer/flake.lock`
  - `pnpm audit --audit-level=high` for `r2-explorer`
  - `vulnix` scan for the built `.#r2` Nix closure
  - baseline allowlist: `scripts/ci/vulnix-whitelist.toml`
- Secret scanning gate:
  - `ripsecrets` in `lefthook` pre-commit jobs
  - CI enforcement through `lefthook run pre-commit --all-files`
- Sensitive change policy gate (`security-sensitive-change-policy`):
  - lockfile/workflow changes require `security-review-approved` label
  - trusted PR authors are exempt from the label: the repository owner
    (`author_association` `OWNER`) plus the `trusted-actors` allowlist in
    `.github/actions/security-sensitive-change-policy/action.yml` (default
    `Bad3r` and `dependabot[bot]`). The author login is set by GitHub from the
    PR head and cannot be spoofed by an untrusted contributor, so their PRs
    still require the label.
  - CODEOWNER review required by branch protection (unchanged for trusted
    authors; it stays the enforcing backstop even when the label is skipped)

## Gate Topology and Branch Protection

Branch protection on `main` must require these status checks:

- `ci-required`: the single aggregation gate over the CI validation jobs.
  Jobs skipped by path filtering count as pass; failed or cancelled jobs
  (including the `changes` detection job) fail the gate.
- `security-sensitive-change-policy`: kept separate from `ci-required` so a
  label add/remove can refresh it through
  `.github/workflows/security-policy-refresh.yml` without rerunning CI.

Self-neutering backstop: the policy check executes the composite action from
the PR head commit, so a PR could edit its own enforcement logic (including
adding itself to the `trusted-actors` allowlist). Because the
workflow that runs on `pull_request` is itself the PR's version, pinning the
action to a trusted base ref cannot close this (the action is repo-local and
absent on base for the PR that introduces it, and a PR could drop the pin
anyway). Two out-of-band controls close the hole instead and must stay in
place:

- `.github/CODEOWNERS` requires owner review for `/.github/workflows/` and
  `/.github/actions/`, so enforcement-surface changes cannot merge on the
  strength of the (self-evaluated) green check alone. This holds only while
  branch protection on `main` has "Require review from Code Owners" enabled and
  is not admin-bypassable; without that setting CODEOWNERS is advisory and the
  self-neutering gap reopens.
- Non-`pull_request` CI runs (push, `workflow_dispatch`) publish the policy
  job under the distinct name `security-sensitive-change-policy
(informational)`. A dispatched run on a PR branch therefore cannot emit a
  fresh SUCCESS under the required check name on the same head SHA and
  supersede a red pull-request result; only `pull_request` events (CI and the
  label-refresh workflow) write the authoritative check.

## Prerequisites

- `nix`, `pnpm`, and `gh` installed.
- Repo checkout on the failing commit/PR branch.
- Permission to apply labels and request reviews on the PR.

## Procedure

1. Identify the failing gate from CI checks.
2. Reproduce locally with the same command:

```bash
./scripts/ci/validate.sh --target root-format-lint
nix run nixpkgs#flake-checker -- --no-telemetry --fail-mode --check-outdated --check-owner --check-supported flake.lock
nix run nixpkgs#flake-checker -- --no-telemetry --fail-mode --check-outdated --check-owner --check-supported r2-explorer/flake.lock
cd r2-explorer && pnpm install --frozen-lockfile && pnpm audit --audit-level=high
nix build .#r2
nix run nixpkgs#vulnix -- -C "$(nix path-info .#r2)" -w ./scripts/ci/vulnix-whitelist.toml
```

3. Apply targeted remediation:
   - For `pnpm audit` findings:
     - upgrade or replace vulnerable dependencies
     - regenerate `r2-explorer/pnpm-lock.yaml` and rerun audit
   - For `flake-checker` findings:
     - update stale flake inputs (`nix flake update` scoped as needed)
     - replace unsupported or non-owner-pinned nixpkgs references
     - rerun `flake-checker` against both lockfiles
   - For `vulnix` findings:
     - update pinned flake inputs (`flake.lock`, `r2-explorer/flake.lock`)
     - rebuild and rerun `vulnix`
     - if risk acceptance is required, update
       `scripts/ci/vulnix-whitelist.toml` in the same PR with justification
     - a `flake.lock` bump that advances a whitelisted package (for example
       `openssl-3.6.0` to `openssl-3.6.2`) invalidates its version-pinned entry
       and re-surfaces the CVEs; rebuild `.#r2` and refresh the baseline with
       `vulnix -C "$(nix path-info .#r2)" -W scripts/ci/vulnix-whitelist.toml`,
       then review the diff under security review
   - For `ripsecrets` findings:
     - remove committed secret material and rotate leaked credentials
     - if false positive, add scoped ignore entries to `.secretsignore`
   - For sensitive change policy failures:
     - add label `security-review-approved`
     - request and obtain CODEOWNER approval (`@Bad3r`)
     - trusted authors (repo owner, `dependabot[bot]`, other `trusted-actors`
       entries) do not hit this failure and need no label; CODEOWNER approval
       still gates the merge

4. Re-run local checks and push fixes.
5. Confirm all required checks are green before merge.

## Failure Signatures

- `pnpm audit` exits non-zero with high/critical vulnerabilities.
- `flake-checker` reports outdated/unsupported/non-compliant flake inputs.
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
