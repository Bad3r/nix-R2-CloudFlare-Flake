# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog,
and this project follows Conventional Commits.

## [Unreleased]

### Added

- `programs.r2-cloud.explorerEnvFile`: optional env file sourced by the `r2`
  wrapper for Worker-share admin variables (`R2_EXPLORER_*`).
- New `services.r2-sync.mounts.*.bisync` controls for safer bisync runs:
- `maxDelete` (percentage 0-100 of files allowed to be deleted per run,
  default `50`, passed to `--max-delete`; see Changed for the corrected default)
- `checkFilename` (remote check file for `--check-access`)
- `initialResyncMode` (auto `--resync` behavior on first run)
- `services.r2-sync.mounts.*.bisync.compare`, `bisync.excludes` and
  `bisync.extraArgs`: per-mount `rclone bisync --compare`, exclude filter
  rules (kept behind a `+ /<checkFilename>` rule so they cannot hide the
  access-check file) and verbatim extra arguments, so a large S3 prefix can
  skip the per-object modtime HEAD requests and keep build trees out of the
  listing (#150). A `compare` or `excludes` change on a mount with existing
  bisync state triggers one automatic `--resync`, which rclone requires after
  a filter change.
- `/api/v2/download`, `/api/v2/preview`, and `/share/<token>` now support `Range`
  and conditional request headers (`If-Match`, `If-None-Match`,
  `If-Modified-Since`, `If-Unmodified-Since`), answering
  `206`/`304`/`412`/`416` as appropriate; `HEAD` returns the same headers
  without streaming the body. A full read still answers `200`, and an
  unsatisfiable range answers `416` even though R2 itself would otherwise
  serve the whole object; `Content-Range` is computed correctly for
  suffix-form ranges (`bytes=-N`) against Cloudflare's real R2 runtime.
- `r2 version` and `r2 --version` print the packaged CLI's derivation version.
- Web console: a `beforeunload` warning while an upload is in progress.
- Web console: the upload file picker's `accept` filter now reflects the
  deployment's allowed extensions/MIME types (`R2E_UPLOAD_ALLOWED_EXT` /
  `R2E_UPLOAD_ALLOWED_MIME`).
- `r2-explorer`: a two-terminal local dev flow (`pnpm dev` plus
  `pnpm dev:web`) proxies `/api` and `/share` to the local API Worker;
  `/share/*` works fully locally, `/api/v2/*` still needs a real Cloudflare
  Access session. See `r2-explorer/web/README.md`.
- docs/quickstart.md documents the full template's standalone
  `homeConfigurations.alice` output (Home Manager without NixOS) for
  non-NixOS hosts that only need the `r2` CLI.

### Changed

- Secrets now standardize on `secrets/r2.yaml` with `/run/secrets/r2/*` outputs,
  and system credentials rendered to `/run/secrets/r2/credentials.env`.
- NixOS and Home Manager modules now support `accountIdFile` and runtime
  endpoint resolution for endpoint-less rclone remotes.
- `services.r2-sync.mounts.*.remotePrefix` is now required (non-empty) for
  bisync and `.trash/` backup-dir correctness.
- Planning docs were reorganized: `docs/plan.md` is now a short index, with the
  full phase content split under `docs/plan/` (including Phase 8 execution docs).
- Wiki sync now ignores planning docs (`docs/plan.md`, `docs/plan/**`).
- GitHub Actions dependencies were bumped:
- `actions/setup-node` v6
- `actions/download-artifact` v7
- `actions/upload-artifact` v6
- `security-sensitive-change-policy` now exempts trusted PR authors from the
  `security-review-approved` label: the repo owner (`author_association`
  `OWNER`) plus a `trusted-actors` allowlist (default `Bad3r`,
  `dependabot[bot]`). Dependabot lockfile/action PRs no longer need a manual
  label to pass the required check; CODEOWNER review still gates the merge.
- **`services.r2-sync.mounts.<name>.bisync.maxDelete`**: now a percentage
  from 0 to 100 (default `50`), matching rclone bisync's real semantics,
  not an absolute delete count. The previous default of `100000` was
  silently clamped by rclone to 100 ("allow up to 100% deletion"), which
  disabled the safety-abort check entirely. A config setting `maxDelete`
  above 100 now fails evaluation; set an intended percentage instead.
  Recovery from a tripped check is a manual `rclone bisync --force` run.
- **`services.r2-sync.mounts.<name>.localPath`**: must now be set to a
  directory that neither equals nor is nested with `mountPoint` (bisync
  must not run against or through the live FUSE mount); the previous
  `null` default silently resolved to `mountPoint` itself. A config
  relying on that default, or pointing `localPath` at a parent/child of
  `mountPoint`, now fails evaluation; set `localPath` to a separate
  directory.
- **`services.r2-sync.mounts.<name>`**: four new assertions run at
  evaluation time:
- mount attribute names must match `[A-Za-z0-9_.-]+` (used verbatim in
  systemd unit names)
- two mounts may not target the same bucket+prefix, nested remote prefixes
  in the same bucket, or overlapping `mountPoint`/`localPath` directories
- `bisync.extraArgs` may not contain filter-shaped flags (`--filter`,
  `--exclude`, `--include`, `--filters-file`, `--files-from`, and related
  forms, or `-f`); use `bisync.excludes` instead so the change is tracked
  for the automatic `--resync`
- a mount whose `r2-mount-<name>.service` runs as a non-root user now
  requires `programs.fuse.userAllowOther = true`, since `rclone mount`
  passes `--allow-other` unconditionally
- A previously-evaluating config that violates any of these now fails at
  evaluation instead of producing a broken unit, a silent overlap, or a
  mount that fails at runtime; see docs/reference/services-r2-sync.md's
  Failure semantics section for the exact messages.
- **`programs.r2-cloud.enableRcloneRemote`**: now asserts against Home
  Manager's own `programs.rclone.enable` when both would write
  `${config.xdg.configHome}/rclone/rclone.conf`; a config enabling both at
  their default paths now fails evaluation instead of the two silently
  racing to overwrite each other's file. Set a distinct
  `programs.r2-cloud.rcloneConfigPath`, declare the R2 remote directly
  under `programs.rclone.remotes` instead (see
  docs/reference/programs-r2-cloud-rclone-config.md), or disable one of
  the two.
- **`programs.r2-cloud.rcloneRemoteName`**: now asserted at evaluation
  time to be env-var-safe (`[A-Za-z0-9_]+`) whenever
  `enableRcloneRemote = true` and `accountId` is empty (endpoint-less mode
  exports it as `RCLONE_CONFIG_<REMOTE>_ENDPOINT`). A hyphenated or
  otherwise non-identifier remote name in that combination previously
  evaluated fine and broke every `r2` invocation at runtime; it now fails
  evaluation naming the option. Rename the remote to an env-var-safe
  string, or set `accountId` directly.
- **The `r2` CLI's credentials file (`R2_CREDENTIALS_FILE`) and
  `programs.r2-cloud.explorerEnvFile`**: are now parsed as `KEY=VALUE`
  data (`#`-comments, optionally indented; blank lines; an optional
  `export` prefix; single- or double-quoted values with no shell
  expansion) instead of being executed by `source`. A malformed line now
  fails with `Error: <file>: line <N>: expected KEY=VALUE` instead of
  running as an arbitrary shell command. A well-formed `KEY=VALUE` file
  still loads unchanged; a file that relied on shell features such as
  command substitution or variable expansion in a value no longer works
  and must be flattened to a literal value. See
  docs/reference/programs-r2-cloud.md's "Env file format" section.
- **`POST /api/v2/upload/init`, `POST /api/v2/upload/complete`, and
  `POST /api/v2/object/move`**: all now refuse a write that would replace
  an existing object by default: they answer `409 object_exists`
  (`error.details.key` names the key) unless the request sets
  `overwrite: true`. When `overwrite: true` is set and an object already
  exists at the target, a copy of that object is kept under `.trash/` (the
  same recoverability as delete) before the new object replaces it, so a
  failed write never leaves the key empty. Without `overwrite`, the final
  write is conditional on the key still being absent, so a key created
  after the check still fails with `object_exists` and the staged upload
  stays retryable. A caller that relied on a silent overwrite
  must now pass `overwrite: true` explicitly; the bundled web console
  already does, through its new Overwrite/Skip prompts (see Fixed).
- **`R2E_READONLY`** (and any other boolean-typed Worker environment
  variable through the shared `envBool` helper): an unrecognized,
  non-empty value now fails the request with `500 config_invalid` naming
  the variable, instead of silently falling back to `false`. A deployment
  with a typo such as `R2E_READONLY=tru` previously ran with readonly mode
  silently disabled; it now fails loudly until the value is corrected to a
  recognized boolean string.
- **`R2E_UPLOAD_SIGN_TTL_SEC`**: now validated against
  `R2E_UPLOAD_PART_SIZE_BYTES` (minimum throughput 1 MiB/s);
  `/api/v2/upload/init` fails fast with `500 upload_config_invalid` naming
  both variables and the minimum TTL required when the configured TTL is
  too low for the configured part size. The documented defaults (60s,
  8 MiB) still pass; a very large part size kept at the default TTL will
  now fail until `R2E_UPLOAD_SIGN_TTL_SEC` is raised.
- **`GET /share/<token>`**: `HEAD` no longer consumes a `maxDownloads`
  slot (it reports the same status a `GET` would); a `Range` continuation
  of an already-started download within a 15 minute resume window is also
  free, even once the cap is reached, while a cold `Range` request with no
  prior start still consumes a slot; revocation is now enforced
  authoritatively by the per-token counter Durable Object, not just KV,
  closing a window where a stale, pre-revocation KV read could still allow
  a download. A health check that used `curl -I` to avoid spending a
  download slot no longer needs to; see
  docs/operators/rollback-worker-share.md.
- **`POST /api/v2/object/delete` and `POST /api/v2/object/move`**: both
  now reject any request whose key (source or destination) starts with
  `.git-annex/` with `400 invalid_delete`/`invalid_move`, the same
  reserved-prefix protection already applied to the upload staging
  prefix, so the object browser cannot corrupt the git-annex special
  remote's content store.
- **`r2-explorer/wrangler.toml`**: `[limits] subrequests` is raised to
  `25000` (root and `env.preview`), since completing a very large staged
  upload can need upward of 20000 R2 subrequests (roughly 2 per copy-part
  at the 128 MiB copy-part size and R2's 10000-part ceiling), above the
  Workers Paid plan's default of 10000. No action is needed for a
  redeploy through the existing workflow; a self-managed Worker on a plan
  that cannot raise this limit should lower the effective promotion
  ceiling instead (see the comment on
  `PromoteObjectLimits.copyPartSizeBytes` in `src/r2.ts`).
- **`.github/workflows/release.yml`**: the `RELEASE_PUSH_TOKEN` secret is
  now required; its `preflight` job fails immediately, before checkout or
  build, when the secret is empty, naming the secret and why
  `GITHUB_TOKEN` cannot substitute (GitHub does not run
  `pull_request`-triggered workflows, including `ci.yml`'s required
  checks, for a branch or PR created with `GITHUB_TOKEN`). Previously an
  empty `RELEASE_PUSH_TOKEN` silently fell back to `GITHUB_TOKEN` and only
  failed after a 90 minute merge-wait timeout. See docs/versioning.md.
- **`scripts/ci/clear-r2-access-gate.sh`**: now requires exactly one of
  `--dry-run` or `--yes` (rejects neither and rejects both); it previously
  deleted matching stale Access apps unconditionally on any successful
  match, with no preview. Run with `--dry-run` first to review matches,
  then `--yes` to delete. See docs/operators/access-policy-split.md.
- **`systems` in `flake.nix` and `r2-explorer/flake.nix`**: `x86_64-darwin`
  is dropped (the pinned nixpkgs revision no longer builds it);
  `x86_64-linux`, `aarch64-linux`, and `aarch64-darwin` remain, now stated
  in a new README.md "Supported Systems" section. `nix flake show` on
  either flake previously threw
  `'checks.x86_64-darwin' is not an attribute set`; a consumer pinned to
  `x86_64-darwin` must stay on an older `nixpkgs` input.
- **`scripts/ci/validate.sh`'s `root-format-lint` target**: no longer runs
  an auto-fixing `nix fmt` before checking; formatting is now verified
  only through `lefthook run pre-commit --all-files`'s
  `treefmt --fail-on-change`, so a misformatted tracked file now fails the
  target instead of being silently reformatted and passing. Every Nix
  evaluation and template check in `validate.sh` also now fetches the
  flake as `git+file://<repo>` instead of an unfiltered `path:`, so only
  git-tracked (and `git add`ed) content is visible to evaluation; a new
  file stays invisible until `git add`ed, and `.env`/`.git`/`node_modules`
  no longer leak into `/tmp` or the Nix store. Override the flake
  reference with `NIX_VALIDATE_FLAKE_REF` (for example inside a linked
  Lix worktree, where a clean worktree cannot be fetched as `git+file`).
- **`r2-restic-backup.service` exit code**: after a `restic backup` exit
  `3` (some source files were unreadable but a snapshot was still
  created), the unit now runs `restic unlock` and `restic forget --prune`
  to completion and only then re-exits `3`, so `systemctl status` and any
  monitoring still report failure even though retention cleanup did run.
  Previously exit `3` skipped `forget --prune` entirely; re-check any
  alert that assumed pruning never happens on exit `3`. See
  docs/reference/services-r2-restic.md's Failure semantics section for
  the exact exit-code branches.
- `r2` now warns on stderr when a credentials-file/environment
  `R2_ACCOUNT_ID` differs from the Home-Manager-provided
  `R2_DEFAULT_ACCOUNT_ID`; the credentials-file/environment value still
  wins.
- `services.r2-sync` bisync timer now adds a 30s `RandomizedDelaySec` so
  multiple mounts sharing `syncInterval` do not fire in lockstep against
  the R2 API.

### Removed

- `vulnix` Nix closure vulnerability scanning:
  - CI steps `Build root package for closure scan` and
    `Scan Nix closure with vulnix` in `security-dependency-audit`
  - `lefthook` pre-commit job `vulnix` and `scripts/hooks/vulnix-scan.sh`
  - `scripts/ci/vulnix-whitelist.toml` baseline allowlist
  - `vulnix` from the `devShells.hooks` package set

### Fixed

- Home Manager `r2` wrapper now exports rclone endpoint when `enableRcloneRemote` is enabled.
- `services.r2-sync` FUSE mount unit no longer uses mount-namespace sandboxing
  that makes mounts invisible outside the unit.
- `services.r2-sync` bisync now:
- seeds the remote `--check-access` file to avoid remote mtime drift
- uses an explicit workdir under `/var/lib/r2-sync-<name>/bisync`
- auto-runs `--resync` on first run when bisync state is missing
- passes `--max-delete` as an integer percentage (0-100, default `50`; see
  Changed for the corrected default)
- CLI worker share signing now includes `awk` via `gawk` runtime input.
- Worker share quickstart/docs now use the correct `url` response field.
- Worker share quickstart now uses `tokenId` (and best-effort revoke cleanup)
  instead of the non-existent `id` field.
- Worker share downloads now honor per-record bucket aliases via `R2E_BUCKET_MAP`.
- Operator key rotation guidance now explicitly requires `wrangler kv ... --remote`
  to avoid updating local Miniflare KV storage instead of the deployed Worker.
- Worker Access auth now accepts the Access session `CF_Authorization` cookie as
  a JWT source, fixing GUI share-management calls when `/api/share/*` is an
  Access `Bypass` (HMAC CLI path).
- `services.r2-sync` bisync service now sets `TimeoutStartSec = infinity` and
  `TimeoutStopSec = 2min`, so systemd's 90s default no longer kills a long
  first resync, and a stop has margin over rclone's own graceful-shutdown
  budget.
- `services.r2-sync` now passes `--s3-no-check-bucket` to every rclone
  invocation (mount, bisync, and the check-file preflight), and the generated
  Home Manager `rclone.conf` now sets `no_check_bucket = true`; both are
  required for least-privilege R2 "Object Read & Write" API tokens, which
  cannot create buckets.
- `r2-restic-backup` no longer skips `restic forget --prune` after a
  `restic backup` exit `3`; it also runs `restic unlock` immediately
  before `forget --prune` (matching nixpkgs' `services.restic.backups.*`
  `pruneCmd`), and sets `RESTIC_CACHE_DIR` and a systemd `CacheDirectory`
  (`0700`) instead of relying on an unset `$HOME`.
- `git-annex-r2-init` now checks that its configured rclone remote actually
  exists before calling `git annex initremote`, and reports a specific error
  naming the missing remote, the consulted rclone config path, and
  `programs.r2-cloud.enableRcloneRemote`, instead of a generic git-annex path
  error.
- The Home Manager R2 credentials activation fragment no longer leaves
  `umask 077` set for every later activation fragment in the same
  `home-manager switch` run; the credentials directory is still created
  `0700` regardless of the ambient umask.
- The Home Manager R2 credentials activation now trims a resolved account-ID
  file the same way `lib/r2.nix`'s shared helper does (leading/trailing
  whitespace and a trailing CR), instead of using the raw, untrimmed value.
- `r2` now detects curl transport failures (connection refused, timeout) in
  worker share commands directly, instead of relying on an accidental
  HTTP-000 status code.
- The Home Manager `r2` wrapper now forwards `help`, `--help`, `version`,
  `--version`, and a bare invocation straight to the CLI without requiring a
  readable account-ID file or credentials file first.
- `r2 bucket delete` now reports a clear error when stdin is not
  interactive, instead of failing with no output.
- `r2 share` and `r2 rclone` now print full usage and exit 0 on a bare
  invocation, matching `r2 bucket`, `r2 bucket lifecycle`, and
  `r2 share worker`.
- A typo'd `r2 bucket lifecycle` subcommand now names itself as unrecognized
  in the legacy-alias error, instead of only complaining about the
  retention-days value.
- `r2 bucket lifecycle add` now rejects an empty prefix instead of silently
  applying the lifecycle rule to the entire bucket (security).
- `r2 bucket lifecycle add` now surfaces the specific missing-value error for
  a malformed flag instead of a generic usage message.
- `r2 share worker create`'s `--max-downloads` validation now reports the
  offending value, matching every other numeric flag in the CLI.
- `r2 rclone help <cmd>` and `r2 rclone <cmd> --help` now reach real
  rclone's help output instead of the wrapper's generic banner.
- docs/sharing.md now notes that a bucket literally named `worker` cannot be
  used with `r2 share` (it is reserved for `r2 share worker`); rename the
  bucket if this collides.
- Cloudflare Access service-token headers for `r2 share worker` commands are
  now passed to curl via a file descriptor instead of argv, so they no
  longer appear in `/proc/<pid>/cmdline` (security).
- The web console now offers an explicit Overwrite choice on a
  `409 object_exists` conflict (Overwrite/Cancel for a move, Overwrite/Skip
  for an upload) instead of silently overwriting or failing hard.
- A non-JSON error response (an HTML error page, plain text) from the API no
  longer becomes the user-facing message verbatim in the web console.
- Move, delete, and share actions in the web console report success/failure
  to their own confirm UI instead of closing it unconditionally; the delete
  confirmation manages focus (moves to Cancel on open, Escape cancels, focus
  returns to the trigger button on close).
- An expired presigned part-upload URL (`403`) now retries with a fresh
  signature instead of failing the whole upload.
- The object table shows its loading state, not a false "no objects"
  message, before the first listing attempt finishes.
- Folder rows in the web console show their relative name instead of the
  full absolute prefix.
- Only the selected (or first) row in the object table is a Tab stop; arrow
  keys move selection like `j`/`k`.
- The share TTL field in the web console has persistent format guidance and
  rejects an ambiguous bare number before it reaches the API.
- A transient failure on the final `upload/complete` call now retries
  instead of forcing a full re-upload.
- Validation errors in the web console show the specific field/reason
  instead of a generic message; empty files are rejected client-side before
  upload starts.
- The Shift+R quick-share shortcut now uses the Inspector's current
  TTL/max-downloads fields instead of hardcoded defaults.
- The object list page size follows `session.limits.uiMaxListLimit` instead
  of a hardcoded 200.
- The theme toggle no longer flashes the wrong icon/label on load.
- A generic or missing declared upload Content-Type (empty string or
  `application/octet-stream`) no longer causes a false `upload_magic_mismatch`
  once the uploaded bytes match a known signature (PDF, PNG, JPEG, GIF, WEBP,
  ZIP family); the detected type is reported back, stored on the promoted
  object, and reported consistently on a replayed `complete`. Upload init
  also omits `contentType` entirely when the browser reports none, letting
  the server's own detection apply.
- The web upload client now waits out the server's
  `upload_promotion_in_progress` `409` on `complete` (bounded, about 20
  minutes) instead of failing and aborting an upload that is still finishing
  server-side.
- Multipart upload completion now survives a promotion failure by resuming
  instead of re-running assembly (a `staged` session status records that
  R2-side assembly already succeeded), and `/api/v2/upload/abort` now
  succeeds in every session state instead of throwing on an already-consumed
  upload ID. A retried `/api/v2/upload/complete` after a full success now
  replays the original response instead of returning
  `409 upload_session_not_active`.
- Uploading a declared zero-byte file now returns the specific
  `upload_empty_file` error instead of a generic `validation_error`.
- A concurrent or retried multipart upload `complete` can no longer race a
  still-promoting request into losing the newly uploaded object: a
  promotion lease serializes the existence-check/soft-delete/promote
  sequence, and a competing request gets `409 upload_promotion_in_progress`
  with `error.details.retryAfterSeconds` instead. The promoter renews the
  lease before every write of its copy loop, so a promotion longer than the
  15 minute window keeps it, and the lease carries a fencing token: a
  promoter whose lease lapsed and was taken over by a retry can no longer
  release that lease, record completion, or write another part (its copy is
  aborted, and its 409 carries `error.details.reason` `lease_lost`).
- An upload session no longer expires while its promotion lease is live:
  acquiring or renewing the lease defers `expiresAt` one lease window past
  the lease, so the expiry alarm cannot delete a staged object that is still
  being copied to its final key.
- The staged object is deleted only after the session store has recorded
  completion (and reclaimed at expiry if that delete never ran), and a
  retried `complete` recognizes its own already-promoted object at the target
  key (`uploadSessionId` custom metadata, set at `init`) instead of failing
  with `upload_staged_object_missing` or `409 object_exists`.
- Retrying `/api/v2/upload/complete` after a crash mid-completion (the
  server confirmed multipart assembly but never recorded it) now resumes
  instead of returning a bare `500 internal_error`.
- Aborting an upload while its promotion is still in progress no longer
  deletes the staged object out from under it (`/api/v2/upload/abort` now
  respects the same promotion lease as `complete`).
- `/api/v2/download` and `/api/v2/preview` no longer return `500` for object
  keys containing non-Latin-1 characters (CJK, emoji, and similar);
  `Content-Disposition` now includes an RFC 6266 `filename*` fallback.
- JWKS signing-key fetches for Worker Access auth no longer scale with
  request count under bad-signature replay, invented-`kid` spam, concurrent
  cold starts, or a JWKS outage (in-flight de-duplication, a 5s negative
  cache, and a 30s rate limit on forced refreshes); a genuine key rotation
  still authenticates within 30s. A token with no `kid` claim now gets one
  rate-limited refetch-and-retry on a signature failure, so a rotation on a
  kid-less signing key is still picked up; a signature failure against a
  token that does carry a known `kid` never forces a refetch, since the same
  key would just come back.
- Object delete and move now copy through the same size-aware (single-put or
  multipart) path as upload promotion, so an object above R2's single-put
  limit can be deleted or moved instead of failing.
- One corrupted share record no longer hides every other share for the same
  object from `GET /api/v2/share/list`.
- `putShareRecord` now writes the share index entry before the primary
  record, so a failed second write leaves no invisible-but-redeemable share.
- Documented that the `key` query parameter on `/api/v2/meta`,
  `/api/v2/download`, and `/api/v2/preview` must be percent-encoded with
  `encodeURIComponent`; a literal `+` decodes as a space and silently looks
  up the wrong key.
- Documented that removing or repointing an `R2E_BUCKET_MAP` alias affects
  every outstanding share that referenced it.
- `scripts/ci/validate.sh`'s temporary checkouts (used by `root-format-lint`
  and the template checks) are now cleaned up on failure and on
  SIGINT/SIGTERM, not only on a clean return, and the script now exits
  promptly on SIGINT/SIGTERM instead of resuming after the trap handler; the
  checkout snapshot also no longer aborts when a tracked file has been
  deleted from the working tree without being staged.
- `nix run ./r2-explorer#deploy` and `#deploy-web` now fail on a drifted
  `pnpm-lock.yaml` instead of silently rewriting it
  (`pnpm install --frozen-lockfile`).
- `flake.nix`'s description no longer says "(Phase 1 scaffold)"; the
  stale-phase language CI scan now also covers `flake.nix` and
  `r2-explorer/flake.nix` descriptions, not just Markdown docs.
- `.treefmt.toml` no longer reformats the vendored `.agents/` skills tree
  (vendored by `npx skills add` and pinned in `skills-lock.json`);
  reformatting it would diverge from upstream and return on every refresh.
- Every job in `release.yml` and `r2-explorer-deploy.yml` now sets
  `timeout-minutes`, so a hung step (a stuck wrangler/Cloudflare call, a
  stuck `pnpm install`) cannot block production releases/deploys for up to
  GitHub's default six hours.
- `scripts/ci/worker-share-smoke.sh` now revokes its test share token on
  every exit path, not only when every assertion passes.
- `scripts/ci/worker-share-smoke.sh`'s authenticated API probe now reports
  the specific Cloudflare Access remediation when a stale Access app
  redirects it, instead of a bare status mismatch.
- `scripts/ci/lib.sh`'s `cf_api_get` and `clear-r2-access-gate.sh`'s
  `cf_api_delete` now bound every Cloudflare API curl call with configurable
  timeouts (`CF_API_TIMEOUT_SEC`/`CF_API_CONNECT_TIMEOUT_SEC`), report a curl
  transport failure (connection refused, timeout) explicitly instead of a
  bare curl exit code, and surface Cloudflare's actual JSON error body on an
  HTTP error response instead of a bare curl error.
- `scripts/ci/sync-wiki.sh` now fails loudly on any `docs/*.md` file that is
  neither mapped nor explicitly excluded, and adds the two operator runbooks
  (`docs/operators/rollback-cli-release.md`,
  `docs/operators/web-csp-analytics.md`) that were silently missing from the
  wiki.
- docs/operators/rollback-worker-share.md now lists the two `_PREVIEW`
  Access variables `render-r2-explorer-wrangler-config.sh` requires, and its
  verification step no longer consumes its own test share's only download.
- docs/quickstart.md no longer instructs `sudo nixos-rebuild switch` against
  the templates' own placeholder `nixosConfigurations` (a tmpfs root and a
  stub bootloader device that exist only so `nix flake check` passes); step
  4 is now build-only (`nixos-rebuild build`/`build-vm`, with a warning
  callout) and a new step 5 walks through integrating the template's
  `services.r2-sync`/`services.r2-restic`/`programs.*` blocks into a real
  host configuration.
- docs/quickstart.md and docs/troubleshooting.md now use the templates'
  generic `files`/`backups` bucket names and a `files.example.com`
  placeholder domain, instead of the maintainer's real production bucket
  names and hostname.
- docs/quickstart.md's sharing checkpoint now verifies with a real `GET`
  instead of `HEAD`, creates the test share with `--max-downloads 2` so the
  verification request does not exhaust it, and reports a failed cleanup
  revoke instead of swallowing it with `|| true`.
- docs/troubleshooting.md's large-prefix entry now reflects the module's
  `TimeoutStartSec = infinity` default instead of describing the old 90s
  kill as a permanent fact; added entries for the bisync max-delete safety
  abort, `r2-restic-backup` exit status `3`, generic `services.r2-sync`
  assertion failures, the `x86_64-darwin` platform drop, and two web/API
  error codes (`409 object_exists`, the percent-encoding 404 case).
- templates/minimal and templates/full now follow the root flake's
  `nixpkgs` (and, for `full`, `home-manager`) from the `r2-cloud` input
  instead of locking a second, independent copy of each.

## [v0.1.0] - 2026-02-07

### Added

- Phase 1 scaffold for a standalone flake, including:
  - `flake.nix`, `default.nix`, and lockfiles
  - NixOS/Home Manager module skeletons under `modules/`
  - CLI package skeletons under `packages/`
  - Shared library placeholders in `lib/r2.nix`
  - `r2-explorer/` Worker subflake scaffold
  - Consumer templates under `templates/`
- Base docs for credentials, sync, sharing, and versioning.
- Generic CI validation workflow in `.github/workflows/ci.yml`.
- Reusable validation runner `scripts/ci/validate.sh`.
- Phase 2 NixOS module implementations:
  - `services.r2-sync` with per-mount `r2-mount-*` and `r2-bisync-*` units/timers.
  - `services.r2-restic` with backup service/timer, retention, and schedule controls.
  - Fail-fast assertions for required configuration when services are enabled.
- Dev quality-gate configuration:
  - `lefthook.yml` pre-commit hooks (`treefmt`, `deadnix`, `statix`)
  - `.treefmt.toml` formatter configuration
  - `scripts/lefthook-rc.sh` hook runtime PATH cache
  - Flake packages `lefthook-treefmt` and `lefthook-statix`
- Phase 3 Home Manager module implementations:
  - `programs.r2-cloud` wrapped CLI: `r2`
  - `programs.r2-cloud.credentials` secure env-file assembly from file-based secrets
  - managed `rclone.conf` generation (`modules/home-manager/rclone-config.nix`)
- Home Manager module validation coverage in `scripts/ci/validate.sh`:
  - positive evaluation checks for Stage 3 wrapper availability
  - positive evaluation checks for generated R2 `rclone.conf`
  - expected-failure checks for Stage 3 assertion paths
- Phase 4 CLI package extraction/refactor:
  - `packages/r2-cli.nix` implements the `r2` command
  - `r2` subcommands: `bucket`, `share`, and `rclone`
- Option reference documentation under `docs/reference/`:
  - `services.r2-sync`
  - `services.r2-restic`
  - `programs.r2-cloud`
  - `programs.r2-cloud.credentials`
  - managed rclone config behavior for `programs.r2-cloud`
  - `programs.git-annex-r2`
- Troubleshooting matrix documentation in `docs/troubleshooting.md` with
  command-level diagnostic and repair workflows for:
  - authentication
  - lifecycle
  - bisync
  - restic
  - multipart upload
  - share token validation
- Targeted CI validation interface in `scripts/ci/validate.sh`:
  - `--target <name>` (repeatable) for scoped checks
  - `--list-targets` for discoverability
  - matrix-aligned targets for root and `r2-explorer` validation
- Worker deploy automation baseline for Phase 7.2:
  - `r2-explorer/.github/workflows/deploy.yml` now includes
    PR-driven preview deploys and manual production deploys
  - environment-scoped Cloudflare secrets contract
    (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`)
  - production deploy guard requiring `workflow_dispatch` with `ref=main`
- Root `.gitignore` now ignores `node_modules/` directories.
- `treefmt` now runs `actionlint` against workflow files and `taplo format`
  against TOML files.
- Phase 7.3 security gates:
  - root CI job `security-dependency-audit` now enforces:
    - `flake-checker` lock/input policy checks for root and worker lockfiles
    - Worker `pnpm audit`
    - Nix closure `vulnix` scan with
      `scripts/ci/vulnix-whitelist.toml` baseline
  - root CI job `security-sensitive-change-policy` enforcing sensitive-file
    PR label requirements
  - CODEOWNERS protection for workflow and lockfile updates
  - pre-commit `ripsecrets` scanning via `lefthook`
  - operator remediation runbook in
    `docs/operators/security-gates-remediation.md`
- Manual release automation workflow:
  - `.github/workflows/release.yml` with semver-gated `workflow_dispatch`
  - root/worker release artifact build jobs
  - changelog promotion + release-note extraction helpers in
    `scripts/release/`

### Changed

- CI naming made phase-agnostic (`ci.yml`, `validate.sh`).
- Validation docs now use `./scripts/ci/validate.sh`.
- CI defaults to `CI_STRICT=1` for fail-fast cache/network behavior.
- `scripts/ci/validate.sh` now includes positive and negative NixOS module eval checks
  for Phase 2 service options and assertions.
- `scripts/ci/validate.sh` now runs `nix fmt` and `lefthook run pre-commit --all-files`
  in a temporary checkout to avoid mutating the caller's working tree.
- Hook execution now uses a dedicated lightweight `nix develop .#hooks` shell
  to avoid unnecessary heavy package pulls during validation.
- Validation now probes cache reachability and disables substituters when unreachable
  to avoid repeated narinfo timeout loops. Cache can be overridden via
  `NIX_VALIDATE_SUBSTITUTERS`.
- Repository status docs now mark Phase 2 complete in `README.md` and `docs/plan.md`.
- `AGENTS.md` now defines explicit fail-fast error-handling semantics:
  no masked/silent failures, readable errors, and early config validation.
- Dev shell now includes `lefthook`, `treefmt`, `deadnix`, `statix`, `nixfmt`, `shfmt`,
  and `prettier`; shell startup installs `lefthook` hooks when needed.
- `nix fmt` now points to `treefmt`.
- Documentation status now marks Phase 3 complete:
  - `README.md` updated to reflect Stage 3 implementation state
  - `docs/plan.md` implementation order now checks Phase 3
- `docs/plan.md` now re-scopes Phase 4 from initial CLI implementation to
  package extraction/refactor of Stage 3 wrapper logic.
- `docs/credentials.md` now documents implemented credential file assembly
  semantics and output permissions.
- Flake package exports now use `r2` as the only CLI package output.
- Home Manager `programs.r2-cloud` now delegates CLI execution to package
  derivations and injects defaults via `R2_CREDENTIALS_FILE`,
  `R2_RCLONE_CONFIG`, and `R2_DEFAULT_ACCOUNT_ID`.
- Validation now builds and smoke-tests the primary `r2` package.
- Phase/status docs now reflect implemented Phase 4 behavior:
  `README.md`, `docs/quickstart.md`, `docs/sharing.md`, and `docs/plan.md`.
- Compatibility-specific CLI implementations were removed:
  - deleted `packages/r2-bucket.nix` and `packages/r2-share.nix`
  - removed Home Manager installation of `r2-bucket`/`r2-share` wrappers
  - removed legacy `r2-cli` compatibility alias output from `flake.nix`
- Documentation navigation now points to `docs/reference/index.md` from
  `README.md` and core user guides.
- Repository docs status wording was updated to capability-based descriptions
  and stale milestone language removed from user-facing docs.
- `scripts/ci/validate.sh` now includes a documentation quality gate that
  hard-fails on stale `Phase <n>` language outside `docs/plan.md`, verifies
  required option-reference pages, and checks required reference links.
- `docs/plan.md` milestone status now marks `6.2` and `6.6` complete.
- User/operator docs now link to `docs/troubleshooting.md` as the first-line
  triage entrypoint:
  - `docs/quickstart.md`
  - `docs/sync.md`
  - `docs/versioning.md`
  - `docs/sharing.md`
  - `docs/operators/index.md`
- Documentation status tracking now reflects completed troubleshooting
  and runbook milestones in `README.md` and marks Phase `6.5` complete
  in `docs/plan.md`.
- End-user workflow docs now include explicit template-separated local and
  remote checkpoints, including worker-share behavior validation:
  - `docs/quickstart.md`
  - `docs/sync.md`
  - `docs/versioning.md`
- `.github/workflows/ci.yml` now executes a target matrix across:
  - `root-format-lint`
  - `root-flake-template-docs`
  - `root-cli-module-eval`
  - `worker-typecheck-test`
- `docs/plan.md` now marks milestone `7.1` complete.
- Phase 6 documentation status is now fully closed:
  - `docs/plan.md` marks `6.4` complete and sets Phase 6 complete in
    implementation order
  - stale `6.4` reopen note removed and replaced with closure note
  - `README.md` now states Phase 6 is complete and Stage 7 remains open
- `r2-explorer/wrangler.toml` now defines explicit `[env.preview]`
  bindings/vars for CI preview deployments.
- `docs/plan.md` now marks milestone `7.2` complete and includes a
  decision-complete Worker deploy pipeline specification.
- `flake.nix` formatter/hook toolchains now include `actionlint` and `taplo`
  so `nix fmt` and hook/CI runs can execute the expanded `treefmt` config.
- `docs/plan.md` now marks milestones `7.3` and `7.6` complete, with closure
  notes documenting required checks and branch protection controls.
- Versioning and repository docs now document automated release operations:
  - `docs/versioning.md` release input contract and failure semantics
  - `README.md` release automation entrypoints
  - `docs/plan.md` milestone `7.4` marked complete with closure note

### Fixed

- Home Manager `programs.r2-cloud` package list now correctly wraps
  `pkgs.writers.writeBashBin` as a package derivation.
- Standalone import of `homeManagerModules.rclone-config` no longer fails
  when `programs.r2-cloud` options are absent.
- Deadnix findings in templates/library were fixed by removing unused lambda
  patterns (`self` in template flakes and unused arg in `lib/r2.nix`).
- `scripts/lefthook-rc.sh` now refreshes cached hook PATH when either
  `flake.nix` or `flake.lock` changes, avoiding stale-tool failures after
  formatter/linter toolchain updates.
