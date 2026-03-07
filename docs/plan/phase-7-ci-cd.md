# Phase 7: CI/CD + release

## Phase 7 Milestone Matrix (CI/CD + Release)

| Milestone                               | Scope / Tasks                                                                                                                               | Deliverables                                                                  | Exit Criteria                                                                             | Status |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------ |
| **7.1 CI matrix baseline**              | Build root CI jobs for format/lint/flake/module eval and Worker typecheck/tests.                                                            | `.github/workflows/ci.yml` jobs for root + `r2-explorer` checks.              | PRs must pass full validation equivalent to `./scripts/ci/validate.sh`.                   | [x]    |
| **7.2 Worker deploy pipeline**          | Implement deploy workflow for `r2-explorer` with environment scoping, required secrets, and protected branch controls.                      | `.github/workflows/r2-explorer-deploy.yml` production-ready workflow.         | Controlled deployment to Worker using CI credentials only; manual deploy still supported. | [x]    |
| **7.3 Security and supply-chain gates** | Add dependency audit, secret scanning, and policy checks for changed files and lockfiles.                                                   | CI security jobs and documented remediation process.                          | Security gates fail on critical findings and block release merges.                        | [x]    |
| **7.4 Release automation**              | Add semver/tag workflow, changelog generation, and release notes for root + worker updates.                                                 | Release workflow(s), versioning policy, and changelog process docs.           | Tagged release produces reproducible artifacts and clear upgrade notes.                   | [x]    |
| **7.5 Deploy verification + rollback**  | Add preview post-deploy smoke/live checks and rollback playbook for Worker and CLI-impacting changes. Production remains deploy-only in CI. | Post-deploy checks + rollback runbook + optional canary/manual approval step. | Failed preview smoke checks trigger rollback path with documented operator actions.       | [x]    |
| **7.6 Branch protection enforcement**   | Wire required checks, review policy, and merge guards to prevent bypassing release quality bars.                                            | Repository protection configuration documented and enabled.                   | Main branch requires green CI + review before merge/deploy.                               | [x]    |

### 7.2 Worker Deploy Pipeline Specification (2026-02-07)

**Workflow file:** `.github/workflows/r2-explorer-deploy.yml`

#### Triggers

- `pull_request` (`opened`, `synchronize`, `reopened`, `ready_for_review`,
  `labeled`, `unlabeled`)
  with path filter:
  - `r2-explorer/**`
  - `.github/workflows/r2-explorer-deploy.yml`
  - `scripts/ci/worker-share-smoke.sh`
- `workflow_dispatch` with required `ref` input (default `main`)

#### Job topology

- **Preview deploy job**
  - Runs only for same-repository PRs (fork PRs skipped because secrets are
    unavailable), with trusted author association
    (`OWNER`/`MEMBER`/`COLLABORATOR`), and only when PR label
    `preview-deploy-approved` is present.
  - Uses GitHub Environment `preview`.
  - Uses concurrency group `r2-explorer-preview-<pr-number>` with
    `cancel-in-progress: true`.
  - Runs install/typecheck/tests before deploy.
  - Deploy command: `pnpm run deploy -- --env preview`.
- **Production deploy job**
  - Runs only on `workflow_dispatch`.
  - Hard-fails unless `ref == main`.
  - Uses GitHub Environment `production`.
  - Uses concurrency group `r2-explorer-production` with
    `cancel-in-progress: false`.
  - Runs install + web build and deploy steps only.
  - Does not run smoke/live integration checks.
  - Deploy command: `pnpm run deploy`.

#### Required environment secrets

Preview environment (deploy + smoke/live):

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `CF_PREVIEW_CI_SMOKE_BASE_URL`
- `CF_PREVIEW_CI_SERVICE_TOKEN_CLIENT_ID`
- `CF_PREVIEW_CI_SERVICE_TOKEN_CLIENT_SECRET`
- `CF_PREVIEW_CI_SMOKE_BUCKET`
- `CF_PREVIEW_CI_SMOKE_KEY`

Production environment (deploy-only):

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`

#### Required workflow permissions

- `contents: read`
- `deployments: write`

#### Wrangler environment scoping

`r2-explorer/wrangler.toml` defines:

- default (production) bindings and vars
- explicit `[env.preview]` bindings and vars for preview deploys

This allows CI to deploy preview and production with explicit resource
separation.

#### Protection and failure semantics

- Production deployment remains manual-only in CI.
- Non-`main` production refs fail immediately with explicit error output.
- Missing or invalid credentials fail job execution (no silent fallback).
- No `continue-on-error` behavior is allowed for deploy jobs.
- Preview smoke/live credentials are scoped to smoke/test execution steps (not
  global job env), reducing exposure in dependency install/test steps.
- Deploy jobs sync R2 bucket CORS for direct multipart upload traffic before
  rollout, preventing drift where signed `PUT` requests fail with browser CORS
  errors.
- Preview deploy job rejects base-URL drift and requires
  `CF_PREVIEW_CI_SMOKE_BASE_URL == https://preview.files.unsigned.sh`.

#### Manual deploy compatibility

Local operator deploy paths remain supported:

- `nix run .#deploy`
- `pnpm run deploy`

CI automation does not remove break-glass/manual deployment workflows.

#### Validation and acceptance checks

- Same-repo trusted-author PR touching `r2-explorer/**` deploys preview
  successfully only when label `preview-deploy-approved` is present.
- PR without label `preview-deploy-approved` does not deploy preview.
- Fork PR does not attempt deployment.
- `workflow_dispatch` with `ref=main` deploys production (subject to
  environment rules).
- `workflow_dispatch` with non-main `ref` fails before checkout/deploy.
- Preview deploy requires worker checks (`pnpm run check`, `pnpm test`) before
  deploy.
- Production deploy remains deploy-only and does not run smoke/live tests.

### 7.3/7.6 Closure Note (2026-02-07)

- Root CI now includes security jobs:
  - `security-dependency-audit`
  - `security-sensitive-change-policy`
- Dependency gates:
  - Flake lock/input policy scan: `flake-checker` (`--check-outdated`,
    `--check-owner`, `--check-supported`) on root and worker lockfiles
  - Worker dependency audit: `pnpm audit --audit-level=high`
  - Nix closure scan: `vulnix` against built `.#r2` output with tracked
    baseline allowlist `scripts/ci/vulnix-whitelist.toml`
- Secret scanning is enforced through `lefthook` pre-commit `ripsecrets`,
  and CI execution of `lefthook run pre-commit --all-files`.
- Sensitive file policy:
  - changed `**/flake.lock`, `**/pnpm-lock.yaml`, and `.github/workflows/*`
    require PR label `security-review-approved`
  - CODEOWNER protections applied for those files
- `main` branch protection now requires:
  - required checks:
    - `validate (root-format-lint)`
    - `validate (root-flake-template-docs)`
    - `validate (root-cli-module-eval)`
    - `validate (worker-typecheck-test)`
    - `security-dependency-audit`
    - `security-sensitive-change-policy`
  - at least one approving review
  - code owner reviews
  - conversation resolution
  - up-to-date branch before merge

### 7.4 Closure Note (2026-02-07)

- Added manual release workflow: `.github/workflows/release.yml`.
- Workflow trigger and policy:
  - `workflow_dispatch` with inputs `version`, `target_ref`, and `prerelease`
  - strict semver validation (`X.Y.Z` only; no leading `v`)
  - releases restricted to refs resolving to `main`
  - hard-fail if tag `vX.Y.Z` already exists
- Release artifact gates:
  - root build: `nix build .#r2` plus Nix output/closure metadata artifacts
  - worker build: `pnpm install --frozen-lockfile`, `pnpm run check`,
    `pnpm test`, then packaged worker release artifacts
- Changelog and notes automation:
  - `scripts/release/prepare-changelog.sh` promotes `## [Unreleased]` to
    `## [vX.Y.Z] - YYYY-MM-DD` and resets a fresh `Unreleased` template
  - `scripts/release/generate-release-notes.sh` extracts release body markdown
    for GitHub Release publication
- Publish behavior:
  - creates commit `chore(release): vX.Y.Z` on a release branch
  - opens release PR to `main`, enables auto-merge, and waits for merge
  - creates and pushes annotated tag `vX.Y.Z` after merge
  - publishes GitHub Release with generated notes and attached root/worker
    artifacts
- Documentation and runbook coverage:
  - `docs/versioning.md` documents release inputs, token requirements, and
    failure semantics
  - `README.md` now links release automation entrypoints

### 7.5 Closure Note (Updated 2026-03-07)

- Post-deploy smoke and live integration checks are now preview-only:
  - `smoke-preview` runs after `deploy-preview`.
  - `deploy-production` has no CI smoke/live test stage.
- Preview smoke checks are implemented in
  `scripts/ci/worker-share-smoke.sh` and validate:
  - Worker share creation via `r2 share worker create`
  - first `/share/<token>` access success
  - second `/share/<token>` access converges to expected token exhaustion
    (`410`) with bounded retries for KV propagation delays
  - unauthenticated `/api/v2/session/info` remains blocked (`302` Access
    redirect or Worker `401`)
  - authenticated `/api/v2/session/info` succeeds (`200`) via Access
    service-token headers
  - retry/timeout controls via `CF_PREVIEW_CI_SMOKE_*` keys
- Rollback guidance is scoped to preview smoke failures:
  - `rollback-guidance-preview` runs only when `smoke-preview` fails.
- Added CLI-impacting release gate in `.github/workflows/release.yml`:
  - `verify-cli-smoke` validates packaged CLI commands before publish:
    - `r2 help`
    - `r2 bucket help`
    - `r2 share help`
    - `r2 share worker help`
  - gate installs Nix and imports exported closure metadata before executing the
    packaged `r2` artifact, so runtime store dependencies are present
- Added operator runbook for CLI rollback:
  - `docs/operators/rollback-cli-release.md`
  - linked from `docs/operators/index.md` and `docs/versioning.md`

#### 7.5 Validation Scenarios

1. Preview deploy success path:
   - same-repo PR touching `r2-explorer/**`
   - `deploy-preview` and `smoke-preview` pass
   - rollback guidance job does not run
2. Preview smoke failure path:
   - invalid preview smoke object/credentials
   - `smoke-preview` fails
   - `rollback-guidance-preview` runs and publishes rollback checklist
3. Production deploy success path:
   - `workflow_dispatch` with `ref=main`
   - `deploy-production` completes deploy steps only
   - no production smoke/live CI stage runs
4. Access regression detection:
   - if unauthenticated `/api/v2/session/info` is not blocked (`302`/`401`)
   - if authenticated `/api/v2/session/info` fails to return `200`
   - preview smoke checks fail with explicit status mismatch
5. CLI release smoke gate:
   - `verify-cli-smoke` must pass (`r2 help`, `bucket help`, `share help`,
     `share worker help`) before release publish/tag steps

### 7.5 Operational Acceptance Note (Updated 2026-03-07)

- Preview success and rollback drills remain validated by prior workflow runs
  (`21789276067`, `21789308933`, `21789337439`).
- Preview CI service-token credentials remain rotation targets:
  - `CF_PREVIEW_CI_SERVICE_TOKEN_CLIENT_ID`
  - `CF_PREVIEW_CI_SERVICE_TOKEN_CLIENT_SECRET`
- Production workflow policy is deploy-only:
  - production CI no longer requires `CF_PRODUCTION_CI_*` smoke/service-token
    keys
  - production manual dispatch still requires `ref=main`
- Updated preview environment deployment branch policy to allow PR deployment
  refs (`refs/pull/*/merge`) under custom branch policies.
- Production required-reviewer gate intentionally remains disabled as a
  single-maintainer exception.
