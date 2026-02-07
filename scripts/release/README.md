# Release Scripts

Release helpers used by `.github/workflows/release.yml`.

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
