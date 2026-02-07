# CLI Release Rollback Runbook

## Purpose

Restore the last known-good CLI behavior when a release introduces a regression
in `r2` command behavior.

## When to Use

- Release workflow `verify-cli-smoke` fails for a candidate release.
- Post-release user reports confirm command-level regressions.
- `r2` command usage/help surfaces no longer match documented behavior.

## Prerequisites

- Maintainer access to open and merge emergency PRs.
- Access to release history (`CHANGELOG.md`, tags, and release artifacts).
- Ability to trigger `.github/workflows/release.yml`.

## Inputs

- Current failing release tag (for example `v1.2.3`).
- Last known-good release tag.
- Commit range that introduced regression.

## Procedure (PR-first)

1. Confirm scope of regression:
   - run CLI smoke commands against the failing artifact:
   - `r2 help`
   - `r2 bucket help`
   - `r2 share help`
   - `r2 share worker help`
2. Create a rollback PR on top of `main`:
   - revert the offending commit(s), or
   - cherry-pick the minimal fix if full revert is unsafe.
3. Run local CI-equivalent validation before requesting review:
   - `./scripts/ci/validate.sh --target root-cli-module-eval`
4. Merge rollback PR with required approvals/checks.
5. Publish patch release via `.github/workflows/release.yml` using the rollback
   commit on `main`.

## Verification

- Release workflow completes through `verify-cli-smoke` and publish stages.
- Released artifact executes all CLI smoke commands without errors.
- `CHANGELOG.md` includes rollback/fix note for operator traceability.

## Failure Signatures and Triage

- Smoke still fails after rollback PR:
  - rollback did not include all dependent changes.
- Smoke passes locally but fails in release workflow:
  - artifact packaging path mismatch or missing runtime dependency.
- New release passes smoke but users still fail:
  - environment-specific wrapper assumptions (credentials/config paths).

## Recovery

1. If first rollback attempt fails, revert to earlier known-good commit set.
2. Keep release blocked until `verify-cli-smoke` passes in CI.
3. Escalate to incident workflow if regression impacts production operations.

## Post-incident Notes

- Record root cause commit(s), rollback PR, and replacement release tag.
- Document whether docs/tests were missing and add permanent coverage.
