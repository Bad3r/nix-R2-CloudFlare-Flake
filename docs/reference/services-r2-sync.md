# `services.r2-sync` Reference

Provides rclone mount + bisync services/timers for one or more R2 buckets.

Activation condition: `services.r2-sync.enable = true`.

Credentials are expected in `/run/secrets/r2/credentials.env` (rendered from
`secrets/r2.yaml` via sops templates).

Every `mounts.<name>.bucket` must already exist: every rclone invocation
(mount, the bisync check-file preflight, and bisync itself) passes
`--s3-no-check-bucket`, required for least-privilege R2 "Object Read & Write"
tokens (which cannot create buckets), so rclone never attempts to check or
create the bucket before writing to it.

## Options

| Option                                                    | Type                                                         | Default       | Required when enabled                 | Notes                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------ | ------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `services.r2-sync.enable`                                 | boolean                                                      | `false`       | no                                    | Enables service and timer generation.                                                                                 |
| `services.r2-sync.credentialsFile`                        | `null` or path                                               | `null`        | yes                                   | Environment file loaded by systemd units.                                                                             |
| `services.r2-sync.accountId`                              | string                                                       | `""`          | yes (if file unset)                   | Used to build `https://<accountId>.r2.cloudflarestorage.com`.                                                         |
| `services.r2-sync.accountIdFile`                          | `null` or path                                               | `null`        | yes (if literal unset)                | File-based account ID source.                                                                                         |
| `services.r2-sync.mounts`                                 | attrset of submodules                                        | `{}`          | yes (must contain at least one mount) | One mount profile per attr key. Each key must match `[A-Za-z0-9_.-]+` and not be `.` or `..` (used in unit names).    |
| `services.r2-sync.mounts.<name>.bucket`                   | string                                                       | none          | yes                                   | Remote bucket name; must be non-empty.                                                                                |
| `services.r2-sync.mounts.<name>.remotePrefix`             | string                                                       | `""`          | yes                                   | Remote subpath inside the bucket (mount/sync root).                                                                   |
| `services.r2-sync.mounts.<name>.mountPoint`               | path                                                         | none          | yes                                   | Local mount location for `rclone mount`.                                                                              |
| `services.r2-sync.mounts.<name>.localPath`                | `null` or path                                               | `null`        | yes                                   | Local bisync side; must be a directory different from `mountPoint` (enforced by assertion).                           |
| `services.r2-sync.mounts.<name>.syncInterval`             | string                                                       | `"5m"`        | no                                    | `OnUnitActiveSec` for the bisync timer; must be a systemd time span.                                                  |
| `services.r2-sync.mounts.<name>.bisync.maxDelete`         | integer (0-100)                                              | `50`          | no                                    | Percentage of files allowed to be deleted per run before bisync aborts; passed to `rclone bisync --max-delete`.       |
| `services.r2-sync.mounts.<name>.bisync.checkFilename`     | string                                                       | `".r2-check"` | no                                    | Used for `--check-access` safety.                                                                                     |
| `services.r2-sync.mounts.<name>.bisync.initialResyncMode` | enum `path1`, `path2`, `newer`, `older`, `larger`, `smaller` | `"path1"`     | no                                    | Used on first run to seed bisync state.                                                                               |
| `services.r2-sync.mounts.<name>.bisync.maxLock`           | string                                                       | `"15m"`       | no                                    | Passed to `rclone bisync --max-lock`; `""` omits it so locks never expire.                                            |
| `services.r2-sync.mounts.<name>.bisync.timeout`           | string                                                       | `"24h"`       | no                                    | Deadline for one bisync run (the service's `TimeoutStartSec`), a systemd time span; `""` means no limit.              |
| `services.r2-sync.mounts.<name>.bisync.compare`           | `null` or string                                             | `null`        | no                                    | Passed to `rclone bisync --compare` (`size`, `modtime`, `checksum`); `null` keeps rclone's `size,modtime`.            |
| `services.r2-sync.mounts.<name>.bisync.excludes`          | list of strings                                              | `[]`          | no                                    | Each entry becomes a `- <pattern>` filter rule, behind a `+ /<checkFilename>` rule that keeps the check file visible. |
| `services.r2-sync.mounts.<name>.bisync.extraArgs`         | list of strings                                              | `[]`          | no                                    | Appended verbatim, one argv element each. Pattern filters are rejected (use `excludes`); listing filters are tracked. |
| `services.r2-sync.mounts.<name>.vfsCache.mode`            | enum `off`, `minimal`, `writes`, `full`                      | `"full"`      | no                                    | Passed to `--vfs-cache-mode`.                                                                                         |
| `services.r2-sync.mounts.<name>.vfsCache.maxSize`         | string                                                       | `"10G"`       | no                                    | Passed to `--vfs-cache-max-size`.                                                                                     |
| `services.r2-sync.mounts.<name>.vfsCache.maxAge`          | string                                                       | `"24h"`       | no                                    | Passed to `--vfs-cache-max-age`.                                                                                      |

## Mount vs Bisync (How to Use the Two Paths)

Each `mounts.<name>` definition generates two distinct local paths with
different semantics:

- `mountPoint`: a live `rclone mount` view of the remote R2 path.
  - This is not a “synced folder”. It is a remote filesystem view.
  - It uses a VFS cache under `/var/lib/r2-sync-<name>/cache` and may write
    cached/staged data to disk depending on `vfsCache.mode`.
- `localPath`: the local directory used by `rclone bisync` for two-way sync.
  - This is the “Dropbox folder” style local mirror you should edit.
  - Changes are reconciled on the `r2-bisync-<name>` timer.

Typical usage patterns:

- Dropbox-style (recommended): edit `localPath` only; use `mountPoint` only for
  occasional remote inspection/debugging.
- Drive “streaming” style: rely on `mountPoint` (still uses caching) and accept
  online-only behavior.

## Running as a non-root user

`r2-mount-<name>.service` passes `--allow-other` to `rclone mount`
unconditionally so the mount is visible outside the service's own session.
FUSE enforces `user_allow_other` (see `mount.fuse3(8)`) for non-root mounts;
NixOS controls that kernel-level flag through `programs.fuse.userAllowOther`
(default `false`). Setting
`systemd.services."r2-mount-<name>".serviceConfig.User` to a non-root user
without also setting `programs.fuse.userAllowOther = true` fails an
assertion at eval time instead of a runtime FUSE mount failure.

## Failure semantics

When `enable = true`, evaluation fails if any assertion below is violated:

- `services.r2-sync.credentialsFile must be set when services.r2-sync.enable = true`
- `services.r2-sync.accountId or services.r2-sync.accountIdFile must be set when services.r2-sync.enable = true`
- `services.r2-sync.mounts must define at least one mount when services.r2-sync.enable = true`
- `services.r2-sync.mounts.<name>.bucket must be a non-empty string`
- `services.r2-sync.mounts.<name>.bucket must be a valid R2 bucket name (3-63 lowercase letters, digits, or hyphens; must start and end with a letter or digit): got '<bucket>'`
- `services.r2-sync.mounts.<name>.remotePrefix must be non-empty after normalization (required for bisync trash backup-dir outside sync root): got '<remotePrefix>'`
- `services.r2-sync.mounts.<name>.remotePrefix must not be '.trash' or nested under it (the bisync remote backup-dir '<bucket>/.trash/<remotePrefix>' must stay outside the sync root): got '<remotePrefix>'`
- `services.r2-sync.mounts.<name>.bisync.compare must be a comma-separated list of size, modtime, or checksum (rclone bisync --compare; null omits the flag): got '<compare>'`
- `services.r2-sync.mounts.<name>.bisync.timeout must be '' (no limit) or a systemd.time(7) time span such as '24h' or '1h 30min' (systemd ignores a TimeoutStartSec it cannot parse, which leaves the run unbounded): got '<timeout>'`
- `services.r2-sync.mounts.<name>.syncInterval must be a systemd.time(7) time span such as '5m' or '1h 30min' (systemd ignores an OnUnitActiveSec it cannot parse, which leaves the timer firing once and never again): got '<syncInterval>'`
- `services.r2-sync.mounts.<name> is not a valid mount name (must match [A-Za-z0-9_.-]+ so it can be used safely in a systemd unit name, and must not be '.' or '..', which would put the local bisync trash directory .trash/<name> outside itself): got '<name>'`
- `services.r2-sync.mounts.<name>.localPath must not equal or be nested with mountPoint (bisync must not run against or through the live FUSE mount): set services.r2-sync.mounts.<name>.localPath to a separate local directory`
- `services.r2-sync.mounts.<name>.bisync.extraArgs must not contain filter flags (--filter, --filter-from, --exclude, --exclude-from, --exclude-if-present, --include, --include-from, --filters-file, --files-from, --files-from-raw, --files-from0, --metadata-filter-from, --metadata-exclude-from, --metadata-include-from, or -f alone, attached as -f=X or -fX, or in a shorthand cluster such as -vf; a separate option value such as -offsite, a single '-' and then only letters or digits up to an 'f', reads as one, so pass it as --flag=value): put pattern rules in services.r2-sync.mounts.<name>.bisync.excludes and metadata rules in inline --metadata-filter, --metadata-exclude or --metadata-include flags, which are tracked for the automatic --resync`
- `services.r2-sync.mounts.<name>.bisync.extraArgs must not contain --delete-excluded: rclone bisync applies it to every copy a run makes, which then deletes each file on the receiving side that the copy does not carry, excluded or not, and bisync.maxDelete does not count those deletions`
- `services.r2-sync.mounts.<name>.bisync.extraArgs must not contain flags the module already passes to rclone bisync (--max-delete, --backup-dir1, --backup-dir2, --max-lock, --recover, --resilient, --workdir, --check-access, --check-filename, --compare): rclone takes the last occurrence of a repeated scalar flag, so repeating one here silently overrides the module's own value, which can disable the bisync.maxDelete abort guard, turn the backup-dir soft delete into a real delete, desync bisync's on-disk state from the module's own workdir and resync tracking, disable the --check-access safety check, move the check file --check-access looks for away from the one the module already copied under checkFilename, or turn off the crash and transient-error recovery that bisync.timeout now relies on to leave a usable listing behind; set bisync.maxDelete, bisync.maxLock, bisync.checkFilename or bisync.compare, the four of these with a dedicated option; the rest are fixed by the module and have none: the backup directories follow localPath/remotePrefix, the workdir is /var/lib/r2-sync-<name>/bisync, and --check-access, --recover and --resilient are always on`
- `services.r2-sync.mounts.<name> runs r2-mount-<name>.service as non-root user '<user>' without programs.fuse.userAllowOther = true (rclone mount passes --allow-other unconditionally, which requires user_allow_other for non-root mounts): set programs.fuse.userAllowOther = true`
- `services.r2-sync.mounts.<name-a> and services.r2-sync.mounts.<name-b> both target bucket '<bucket>' prefix '<prefix>': two mounts must not target the same remote tree`
- `services.r2-sync.mounts.<name-a> (bucket '<bucket>' prefix '<prefix-a>') and services.r2-sync.mounts.<name-b> (prefix '<prefix-b>') have nested remote prefixes in the same bucket: concurrent bisync runs must not overlap trees`
- `services.r2-sync.mounts.<name-a>.<mountPoint|localPath> ('<path-a>') and services.r2-sync.mounts.<name-b>.<mountPoint|localPath> ('<path-b>') overlap: each mount must use independent mountPoint and localPath directories`

Cross-mount checks (the last three above) compare every pair of mounts once,
so each pair that violates more than one rule can surface more than one of
these messages at the same time.

## Trash and safety behavior

- Bisync uses `--check-access` with a per-mount check file (default:
  `.r2-check`). The module ensures the file exists locally and creates it on
  the remote only if missing (it does not update the file once present, since
  changing the check file forces a manual `--resync` recovery).
- Bisync passes `bisync.maxDelete` (default `50`) as a percentage (0-100) of
  the tracked files: if a run would delete more than that percentage (for
  example because a listing came back empty), bisync aborts without touching
  anything on either side. rclone silently clamps any value above 100 to
  100, which disables the check entirely, so the option's type rejects
  out-of-range values at eval time instead of forwarding them. Recovery from
  a legitimate mass delete that trips the check is a deliberate manual
  `rclone bisync ... --force` run (same `--workdir`, `--backup-dir1`,
  `--backup-dir2`, and local/remote paths as the generated unit) after
  inspecting why so many deletes were expected. The check counts only the
  deletions bisync plans itself, which is why `--delete-excluded` is rejected
  in `bisync.extraArgs`: rclone applies it to every copy a run makes, and
  that copy then deletes each file on the receiving side it does not carry,
  excluded or not.
- Bisync uses backup dirs for soft-delete style recovery:
  - local backup dir: sibling of `localPath`, under `<dirOf(localPath)>/.trash/<name>`
  - remote backup dir: at the bucket root, under `.trash/<remotePrefix>`
  - both are intentionally outside the sync roots to satisfy rclone bisync
    non-overlap requirements.
- Bisync uses a persistent `--workdir` under `/var/lib/r2-sync-<name>/bisync`.
  On first run (no prior state), it automatically runs `--resync` with
  `initialResyncMode` (default: `path1`).
- If prior listing cache exists but no longer matches the current local/remote
  basename pair (for example, path case changes), the wrapper retries once with
  `--resync --resync-mode <initialResyncMode>` automatically.
- Bisync passes `--max-lock` (default `15m`) so a run orphaned by a crash or
  shutdown self-expires and the next run can take over; rclone renews the lock
  while a run is alive and clamps values under 2m up to 2m. Interrupted runs
  self-heal via `--recover`/`--resilient` rather than needing a manual
  `--resync`. As a fast-path the wrapper also clears a `.lck` whose recorded
  holder PID is no longer running and retries once. Setting `maxLock = ""` omits
  `--max-lock` and disables that cleanup, restoring rclone's native behavior
  where an orphaned lock blocks every later run until removed by hand. This
  fast-path lock clear and the stale-listing retry below both match rclone's
  literal log text (upstream `cmd/bisync/lockfile.go` and
  `cmd/bisync/operations.go`, named next to each match in
  `modules/nixos/r2-sync.nix`). A future rclone version that rewords that text
  disables the self-heal with no test failure, so re-check it against the
  `pkgs.rclone` source on every version bump.
- `bisync.compare`, `bisync.excludes`, and the listing filters passed in
  `bisync.extraArgs` (`--min-size`, `--max-size`, `--min-age`, `--max-age`,
  `--max-depth`, `--hash-filter`, `--metadata-filter`, `--metadata-exclude`,
  `--metadata-include` with their values, and `--ignore-case`) are recorded in
  the workdir as `.r2-bisync-flags` after each successful run. When any of
  them changes on a mount that already has listing state, the next run
  performs one automatic `--resync --resync-mode <initialResyncMode>`: rclone
  requires this after a filter change (prior listings would otherwise show
  the newly excluded files as deleted) and recommends it after a compare
  change (prior listings lack the newly compared attribute). rclone only
  guards its own `--filters-file` this way, so the module tracks the inline
  flags itself. Each list is recorded in the order given, so reordering
  `excludes` or those `extraArgs` filters also triggers the resync, even when
  the listing would not change: rclone takes the last value of a repeated flag
  and the first matching `--metadata-filter` rule, so the module cannot tell a
  harmless reorder from one that changes the listing. Pattern filters and
  rules files are rejected in `extraArgs` by
  assertion (see "Failure semantics"): patterns belong in `excludes`, and a
  rules file can change without the configuration changing, so it could not
  be tracked.
- Exclude patterns are rendered as `--filter '- <pattern>'` rules behind a
  leading `--filter '+ /<checkFilename>'` rule. rclone evaluates every
  `--exclude` before any `--filter` and gives `--include` an implied trailing
  `- **`, so this is the only flag form in which a pattern such as `.*` cannot
  hide the access-check file from `--check-access`.

## Service timeouts

- `r2-bisync-<name>.service` is a `oneshot` unit, which systemd starts with no
  start timeout unless one is set (`TimeoutStartSec=` in `systemd.service(5)`),
  so a run that hangs (for example on a stuck network mount, which
  `--max-lock` and `--resilient` do not bound) would block every later timer
  run without ever failing. `bisync.timeout` (default `24h`) sets
  `TimeoutStartSec`: a run still going at the deadline is stopped, the unit
  fails, and the timer starts the next run. A first `--resync` of a very
  large prefix can take longer; raise `bisync.timeout` for it or set `""` for
  no limit (see "Sizing a mount for a large prefix" below for ways to shorten
  that run). Any other value must be a `systemd.time(7)` time span, checked by
  assertion: systemd only logs a `TimeoutStartSec` it cannot parse (such as
  `24hrs`) and runs the unit with no start timeout at all.
- `r2-bisync-<name>.service` sets `TimeoutStopSec = "2min"`: rclone bisync's
  own graceful-shutdown budget is up to 90s (a 30s grace period plus a 60s
  cancel-and-save window), so this keeps a margin over systemd's matching
  90s default before a `systemctl stop`, a shutdown, or an expired
  `bisync.timeout` SIGKILLs a run mid-save.

## Sizing a mount for a large prefix

rclone's default comparison is `size,modtime`. On S3-class backends such as R2
the modtime lives in object metadata, so every listing costs one HEAD request
per object on top of the ListObjects pages. A prefix of tens of thousands of
objects can outlast a bounded unit, and because bisync writes its listings only
after the walk completes, every retry starts from zero. Three per-mount knobs
address this:

- `bisync.compare = "size,checksum"`: size and ETag both come from the listing,
  so no per-object HEAD is needed for single-part uploads (objects below
  rclone's `--s3-upload-cutoff`). The local tree is hashed on every run, and
  without `modtime` bisync only distinguishes `changed` from `unchanged`, not
  `newer` from `older`.
- `bisync.excludes`: keep build and dependency trees such as `node_modules/**`
  and `.venv/**` out of both listings entirely (rclone filtering syntax,
  relative to the sync root).
- `bisync.extraArgs`: flags with no dedicated option, for example
  `--fast-list`, `--checkers 16`, `--use-server-modtime`, or `--links`.

```nix
{
  services.r2-sync.mounts.docs.bisync = {
    compare = "size,checksum";
    excludes = [
      "node_modules/**"
      ".venv/**"
    ];
    extraArgs = [
      "--fast-list"
      "--checkers"
      "16"
    ];
  };
}
```

## Generated runtime artifacts

For each mount name (example: `documents`):

- systemd service: `r2-mount-documents.service`
- systemd service: `r2-bisync-documents.service`
- systemd timer: `r2-bisync-documents.timer`

The bisync timer adds a fixed 30s `RandomizedDelaySec` on top of
`OnUnitActiveSec` so multiple mounts sharing the same `syncInterval` do not
fire in lockstep against the R2 API. `syncInterval` must be a
`systemd.time(7)` time span, checked by assertion: systemd only logs an
`OnUnitActiveSec` it cannot parse (such as `5mins`), and the timer, left with
its `OnActiveSec = "2m"` trigger, fires once after activation and never again.

## Minimal snippet

```nix
{
  services.r2-sync = {
    enable = true;
    credentialsFile = "/run/secrets/r2/credentials.env";
    accountIdFile = "/run/secrets/r2/account-id";

    mounts.documents = {
      bucket = "files";
      remotePrefix = "documents";
      mountPoint = "/mnt/r2/documents";
      localPath = "/var/lib/r2-sync/documents";
    };
  };
}
```

## Expanded snippet

```nix
{
  services.r2-sync = {
    enable = true;
    credentialsFile = "/run/secrets/r2/credentials.env";
    accountIdFile = "/run/secrets/r2/account-id";

    mounts.workspace = {
      bucket = "files";
      remotePrefix = "workspace";
      mountPoint = "/mnt/r2/workspace";
      localPath = "/data/r2/workspace";
      syncInterval = "10m";
      vfsCache = {
        mode = "full";
        maxSize = "20G";
        maxAge = "48h";
      };
      bisync = {
        compare = "size,checksum";
        excludes = [ "node_modules/**" ];
        extraArgs = [ "--fast-list" ];
      };
    };
  };
}
```
