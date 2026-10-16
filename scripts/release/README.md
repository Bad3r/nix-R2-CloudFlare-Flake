# Release Scripts

Release helpers used by `.github/workflows/release.yml`.

## Required release workflow secret

`.github/workflows/release.yml` requires a `RELEASE_PUSH_TOKEN` repository
secret (see `docs/versioning.md` for the permissions it needs). The default
`GITHUB_TOKEN` cannot substitute: GitHub does not trigger `pull_request`
workflows for a PR created with `GITHUB_TOKEN`, so the release PR's required
checks would never run and the merge-wait step would time out. The `preflight`
job fails immediately when the secret is empty.

## `prepare-changelog.sh`

Promotes the current `## [Unreleased]` section in `CHANGELOG.md` into a
versioned section (`## [vX.Y.Z] - YYYY-MM-DD`) and resets `Unreleased` to an
empty template.

```bash
scripts/release/prepare-changelog.sh --version 1.2.3
```

Optional flags:

- `--file <path>`: changelog path (default `CHANGELOG.md`)
- `--date <YYYY-MM-DD>`: explicit release date (default current UTC date)

## `generate-release-notes.sh`

Extracts the release notes body for a specific `vX.Y.Z` section from the
changelog.

```bash
scripts/release/generate-release-notes.sh --version 1.2.3 > RELEASE_NOTES.md
```

Optional flags:

- `--file <path>`: changelog path (default `CHANGELOG.md`)
