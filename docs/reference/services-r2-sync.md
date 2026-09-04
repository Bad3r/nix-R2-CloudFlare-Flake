# `services.r2-sync` Reference

Provides rclone mount + bisync services/timers for one or more R2 buckets.

Activation condition: `services.r2-sync.enable = true`.

Credentials are expected in `/run/secrets/r2/credentials.env` (rendered from
`secrets/r2.yaml` via sops templates).

## Options

| Option                                                    | Type                                                         | Default       | Required when enabled                 | Notes                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------ | ------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `services.r2-sync.enable`                                 | boolean                                                      | `false`       | no                                    | Enables service and timer generation.                                                                                 |
| `services.r2-sync.credentialsFile`                        | `null` or path                                               | `null`        | yes                                   | Environment file loaded by systemd units.                                                                             |
| `services.r2-sync.accountId`                              | string                                                       | `""`          | yes (if file unset)                   | Used to build `https://<accountId>.r2.cloudflarestorage.com`.                                                         |
| `services.r2-sync.accountIdFile`                          | `null` or path                                               | `null`        | yes (if literal unset)                | File-based account ID source.                                                                                         |
| `services.r2-sync.mounts`                                 | attrset of submodules                                        | `{}`          | yes (must contain at least one mount) | One mount profile per attr key.                                                                                       |
| `services.r2-sync.mounts.<name>.bucket`                   | string                                                       | none          | yes                                   | Remote bucket name; must be non-empty.                                                                                |
| `services.r2-sync.mounts.<name>.remotePrefix`             | string                                                       | `""`          | yes                                   | Remote subpath inside the bucket (mount/sync root).                                                                   |
| `services.r2-sync.mounts.<name>.mountPoint`               | path                                                         | none          | yes                                   | Local mount location for `rclone mount`.                                                                              |
| `services.r2-sync.mounts.<name>.localPath`                | `null` or path                                               | `null`        | no                                    | Local bisync side; falls back to `mountPoint`.                                                                        |
| `services.r2-sync.mounts.<name>.syncInterval`             | string                                                       | `"5m"`        | no                                    | `OnUnitActiveSec` value for bisync timer.                                                                             |
| `services.r2-sync.mounts.<name>.bisync.maxDelete`         | integer                                                      | `100000`      | no                                    | Passed to `rclone bisync --max-delete`.                                                                               |
| `services.r2-sync.mounts.<name>.bisync.checkFilename`     | string                                                       | `".r2-check"` | no                                    | Used for `--check-access` safety.                                                                                     |
| `services.r2-sync.mounts.<name>.bisync.initialResyncMode` | enum `path1`, `path2`, `newer`, `older`, `larger`, `smaller` | `"path1"`     | no                                    | Used on first run to seed bisync state.                                                                               |
| `services.r2-sync.mounts.<name>.bisync.maxLock`           | string                                                       | `"15m"`       | no                                    | Passed to `rclone bisync --max-lock`; `""` omits it so locks never expire.                                            |
| `services.r2-sync.mounts.<name>.bisync.compare`           | `null` or string                                             | `null`        | no                                    | Passed to `rclone bisync --compare` (`size`, `modtime`, `checksum`); `null` keeps rclone's `size,modtime`.            |
| `services.r2-sync.mounts.<name>.bisync.excludes`          | list of strings                                              | `[]`          | no                                    | Each entry becomes a `- <pattern>` filter rule, behind a `+ /<checkFilename>` rule that keeps the check file visible. |
| `services.r2-sync.mounts.<name>.bisync.extraArgs`         | list of strings                                              | `[]`          | no                                    | Appended verbatim to every bisync run, one argv element per entry.                                                    |
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

## Failure semantics

When `enable = true`, evaluation fails if any assertion below is violated:

- `services.r2-sync.credentialsFile must be set when services.r2-sync.enable = true`
- `services.r2-sync.accountId or services.r2-sync.accountIdFile must be set when services.r2-sync.enable = true`
- `services.r2-sync.mounts must define at least one mount when services.r2-sync.enable = true`
- `services.r2-sync.mounts.<name>.bucket must be a non-empty string`
- `services.r2-sync.mounts.<name>.remotePrefix must be non-empty (required for bisync trash backup-dir outside sync root)`
- `services.r2-sync.mounts.<name>.bisync.compare must be a comma-separated list of size, modtime, or checksum (rclone bisync --compare; null omits the flag)`

## Trash and safety behavior

- Bisync uses `--check-access` with a per-mount check file (default:
  `.r2-check`). The module ensures the file exists locally and creates it on
  the remote only if missing (it does not update the file once present, since
  changing the check file forces a manual `--resync` recovery).
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
  where an orphaned lock blocks every later run until removed by hand.
- `bisync.compare` and `bisync.excludes` are recorded in the workdir as
  `.r2-bisync-flags` after each successful run. When either changes on a mount
  that already has listing state, the next run performs one automatic
  `--resync --resync-mode <initialResyncMode>`: rclone requires this after a
  filter change (prior listings would otherwise show the newly excluded files
  as deleted) and recommends it after a compare change (prior listings lack
  the newly compared attribute). rclone only guards its own `--filters-file`
  this way, so the module tracks the inline flags itself. Filter flags passed
  through `extraArgs` are not tracked.
- Exclude patterns are rendered as `--filter '- <pattern>'` rules behind a
  leading `--filter '+ /<checkFilename>'` rule. rclone evaluates every
  `--exclude` before any `--filter` and gives `--include` an implied trailing
  `- **`, so this is the only flag form in which a pattern such as `.*` cannot
  hide the access-check file from `--check-access`.

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
