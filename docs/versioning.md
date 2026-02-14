# Versioning

This page covers the versioning workflows used by the `templates/full` profile.
These checks apply only to `templates/full` and should not be mixed into the
`templates/minimal` path.

Option reference: `docs/reference/index.md`, `docs/reference/services-r2-restic.md`, and `docs/reference/programs-git-annex-r2.md`.
If snapshot or auth checks fail, use `docs/troubleshooting.md` for first-line
triage before operator escalation.

Credentials are expected at `/run/secrets/r2/credentials.env`, and restic
password at `/run/secrets/r2/restic-password`, both derived from
`secrets/r2.yaml`.

## Automated release workflow

Repository releases are automated by `.github/workflows/release.yml` and run
through `workflow_dispatch`.

Inputs:

- `version`: strict semver `X.Y.Z` (without leading `v`)
- `target_ref`: must resolve to `main`
- `prerelease`: `true` or `false`

Required credentials:

- default: GitHub Actions `GITHUB_TOKEN` (`contents: write`,
  `pull-requests: write`)
- optional: `RELEASE_PUSH_TOKEN` secret (used for Git push + PR merge/tag/release
  API calls)

Workflow behavior:

1. Preflight validation checks semver format, `target_ref` policy, and verifies
   the release tag does not already exist.
2. Root artifact build runs `nix build .#r2` and captures output/closure
   metadata.
3. Worker artifact build runs `pnpm install --frozen-lockfile`,
   `pnpm run check`, and `pnpm test`, then packages release inputs.
4. CLI smoke verification runs from the packaged root artifact:
   - `r2 help`
   - `r2 bucket help`
   - `r2 share help`
   - `r2 share worker help`
   - workflow installs Nix and imports exported closure metadata before
     invoking artifact binaries
5. Release publish updates `CHANGELOG.md` from `Unreleased` to
   `## [vX.Y.Z] - YYYY-MM-DD`, commits that change to a release branch, opens a
   release PR to `main`, enables auto-merge, waits for merge, then tags
   `origin/main` and creates a GitHub Release with generated notes and attached
   artifacts.

Release helper scripts:

- `scripts/release/prepare-changelog.sh`
- `scripts/release/generate-release-notes.sh`

Failure semantics:

- Non-semver `version` fails preflight before checkout/build.
- Non-`main` `target_ref` fails preflight before checkout/build.
- Existing tag fails preflight and blocks release.
- Missing PR creation or merge permissions fails before tag/release
  publication.
- Any CLI smoke command failure blocks publish/tag steps.
- If required checks on the generated release PR never pass, the workflow times
  out waiting for merge and fails without creating a tag.
- Missing changelog release content for the requested version fails release-note
  generation.

Rollback runbook:

- `docs/operators/rollback-cli-release.md`

## Restic snapshots (`services.r2-restic`)

Template defaults:

- bucket: `backups`
- paths: `/data/r2/workspace`
- timer unit: `r2-restic-backup.timer`
- service unit: `r2-restic-backup.service`

Verify timer and service wiring:

```bash
sudo systemctl status r2-restic-backup
sudo systemctl list-timers | grep r2-restic-backup
```

Run an immediate backup:

```bash
sudo systemctl start r2-restic-backup
```

Expected result:

- restic creates snapshot(s)
- retention policy runs in the same unit invocation

Repository checkpoint:

```bash
set -a
source /run/secrets/r2/credentials.env
set +a
export RESTIC_PASSWORD_FILE=/run/secrets/r2/restic-password

restic -r "s3:https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/backups" snapshots
```

Expected result:

- at least one snapshot is listed for `/data/r2/workspace`
- command exits without repository/authentication errors

## git-annex content workflow (`programs.git-annex-r2`)

The full template installs `git-annex-r2-init` and sets defaults:

- rclone remote name: `r2`
- default bucket hint: `files`
- default prefix: `annex/workspace`

Initialize a repository remote:

```bash
mkdir -p ~/tmp/annex-demo
cd ~/tmp/annex-demo
git init

git-annex-r2-init
```

Track and sync content:

```bash
git annex add large-file.bin
git commit -m "Track large file with git-annex"
git annex sync --content
```

Selective fetch/drop cycle:

```bash
git annex drop large-file.bin
git annex get large-file.bin
```

Expected result:

- annex metadata remains in git
- file content is pushed/pulled via the R2-backed special remote

Remote-placement checkpoint:

```bash
git annex whereis large-file.bin
git annex info r2
```

Expected result:

- `whereis` output includes the `r2` special remote for content availability
- `git annex info r2` reports the configured remote state without errors
