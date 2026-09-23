{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.r2-sync;
  r2lib = import ../../lib/r2.nix { inherit lib; };
  resolveAccountIdShell = r2lib.mkResolveAccountIdShell {
    literalAccountId = cfg.accountId;
    inherit (cfg) accountIdFile;
    envVar = "R2_ACCOUNT_ID";
    outputVar = "R2_RESOLVED_ACCOUNT_ID";
  };
  hasMounts = cfg.mounts != { };

  # Mirrors rclone's --compare parser (cmd/bisync/compare.go, setFromCompareFlag):
  # split on ",", trim, lowercase; each part must be size, modtime or checksum.
  isValidCompare =
    value:
    lib.all (
      part: builtins.match "[[:space:]]*(size|modtime|checksum)[[:space:]]*" (lib.toLower part) != null
    ) (lib.splitString "," value);

  # Endpoint resolved at service runtime from the account ID env/file.
  runtimeEndpoint = r2lib.mkR2Endpoint "\${R2_RESOLVED_ACCOUNT_ID}";

  # Per-mount remote layout derived from the normalized prefix. The module
  # assertions below guarantee a non-empty normalized prefix before any
  # generated unit can be built.
  mkRemoteLayout =
    mount:
    let
      prefix = r2lib.normalizeRemotePrefix mount.remotePrefix;
    in
    {
      inherit prefix;
      path = if prefix == "" then mount.bucket else "${mount.bucket}/${prefix}";
    };

  # The mountPoint fallback only exists so the localPath assertion below can
  # report it: a passing config always has a separate bisync directory.
  resolveLocalPath =
    mount: if mount.localPath != null then toString mount.localPath else toString mount.mountPoint;

  localRoots = mount: [
    {
      role = "mountPoint";
      path = toString mount.mountPoint;
    }
    {
      role = "localPath";
      path = resolveLocalPath mount;
    }
  ];

  # "/data/r2" overlaps "/data/r2/sub" but not "/data/r2-other".
  pathsOverlap = p: q: p == q || lib.hasPrefix "${p}/" q || lib.hasPrefix "${q}/" p;

  # Each unordered pair of mounts once, for the cross-mount assertions.
  mountList = lib.mapAttrsToList (name: mount: { inherit name mount; }) cfg.mounts;
  mountPairs = lib.concatMap (
    a: map (b: { inherit a b; }) (lib.filter (b: a.name < b.name) mountList)
  ) mountList;

  # Rejected in bisync.extraArgs, since neither can be tracked for the automatic
  # --resync (trackedFlags below): pattern rules belong in bisync.excludes, and
  # a rules file can change without the config changing.
  bisyncFilterFlagNames = [
    "--filter"
    "--filter-from"
    "--exclude"
    "--exclude-from"
    "--exclude-if-present"
    "--include"
    "--include-from"
    "--filters-file"
    "--files-from"
    "--files-from-raw"
    "--metadata-filter-from"
    "--metadata-exclude-from"
    "--metadata-include-from"
  ];
  # rclone's other listing filters (the "Filter" flag group) have no bisync
  # option of their own, so extraArgs may carry them and they are tracked there.
  bisyncTrackedFilterFlagNames = [
    "--min-size"
    "--max-size"
    "--min-age"
    "--max-age"
    "--max-depth"
    "--hash-filter"
    "--metadata-filter"
    "--metadata-exclude"
    "--metadata-include"
  ];
  # The tracked filter flags in args with their values: "--flag=value" and the
  # --ignore-case switch as written, "--flag value" as both elements.
  trackedFilterArgs =
    args:
    lib.concatLists (
      lib.imap0 (
        i: arg:
        let
          flag = lib.head (lib.splitString "=" arg);
          takesNext = lib.elem flag bisyncTrackedFilterFlagNames && !lib.hasInfix "=" arg;
        in
        if flag == "--ignore-case" || lib.elem flag bisyncTrackedFilterFlagNames then
          [ arg ] ++ lib.optional (takesNext && i + 1 < lib.length args) (lib.elemAt args (i + 1))
        else
          [ ]
      ) args
    );
  # rclone's flag parser (pflag) also reads -f with its value attached (-f=X,
  # -fX) or at the end of a shorthand cluster (-vf X); every other rclone
  # shorthand is a switch, so any f before "=" in a single-dash token sets it.
  isShortFilterArg =
    arg:
    let
      shorthands = lib.head (lib.splitString "=" arg);
    in
    lib.hasPrefix "-" shorthands && !lib.hasPrefix "--" shorthands && lib.hasInfix "f" shorthands;
  isBisyncFilterArg =
    arg: isShortFilterArg arg || lib.elem (lib.head (lib.splitString "=" arg)) bisyncFilterFlagNames;

  mkMountService =
    name: mount:
    let
      mountPoint = toString mount.mountPoint;
      mountPointArg = lib.escapeShellArg mountPoint;
      layout = mkRemoteLayout mount;
      remoteArg = lib.escapeShellArg ":s3:${layout.path}";
      mountScript = pkgs.writeShellScript "r2-mount-${name}" ''
        set -euo pipefail
        # rclone invokes `fusermount3` for FUSE mounts. On NixOS the setuid wrapper
        # lives in /run/wrappers/bin (the store binary is non-setuid and fails
        # with "Operation not permitted" for non-root mounts).
        export PATH="/run/wrappers/bin:$PATH"
        ${resolveAccountIdShell}
        endpoint="${runtimeEndpoint}"
        exec ${pkgs.rclone}/bin/rclone mount \
          --config=/dev/null \
          --s3-provider=Cloudflare \
          --s3-endpoint="$endpoint" \
          --s3-env-auth \
          --s3-no-check-bucket \
          --vfs-cache-mode=${mount.vfsCache.mode} \
          --vfs-cache-max-size=${lib.escapeShellArg mount.vfsCache.maxSize} \
          --vfs-cache-max-age=${lib.escapeShellArg mount.vfsCache.maxAge} \
          --cache-dir=/var/lib/r2-sync-${name}/cache \
          --allow-other \
          ${remoteArg} \
          ${mountPointArg}
      '';
      # systemd Exec lines do not support shell operators, so the graceful
      # unmount logic must live in a real script.
      unmountScript = pkgs.writeShellScript "r2-unmount-${name}" ''
        set -euo pipefail
        # Only unmount while the path is still a mountpoint; rclone also
        # unmounts on SIGTERM, so this is the graceful first pass.
        if ${pkgs.util-linux}/bin/mountpoint -q ${mountPointArg}; then
          /run/wrappers/bin/fusermount3 -u ${mountPointArg} \
            || /run/wrappers/bin/fusermount -u ${mountPointArg} \
            || /run/wrappers/bin/umount ${mountPointArg}
        fi
      '';
    in
    {
      name = "r2-mount-${name}";
      value = {
        description = "R2 FUSE mount for ${name}";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        wantedBy = [ "multi-user.target" ];
        preStart = ''
          ${pkgs.coreutils}/bin/mkdir -p ${mountPointArg}
        '';
        serviceConfig = {
          Type = "simple";
          EnvironmentFile = cfg.credentialsFile;
          ExecStart = mountScript;
          ExecStop = unmountScript;
          Restart = "on-failure";
          RestartSec = "5s";
          StateDirectory = "r2-sync-${name}";
          # rclone mount relies on fusermount (setuid) for non-root mounts.
          # Keep the service compatible with running as a real user (e.g. `vx`).
          NoNewPrivileges = false;
          # IMPORTANT: any mount-namespace sandboxing will make the FUSE mount
          # invisible outside the service (it ends up mounted only inside the
          # unit's private mount namespace). This unit must run in the host mount
          # namespace so the mount is usable at `mountPoint` system-wide.
          #
          # In practice, `PrivateTmp` and some `Protect*` settings trigger a
          # private mount namespace in systemd.
          PrivateTmp = false;
          ProtectKernelTunables = false;
          ProtectKernelModules = false;
          ProtectControlGroups = false;
          RestrictSUIDSGID = false;
          LockPersonality = true;
        };
      };
    };

  mkBisyncService =
    name: mount:
    let
      localPath = resolveLocalPath mount;
      localPathArg = lib.escapeShellArg localPath;
      localBaseDir = builtins.dirOf localPath;
      localTrashPath = "${localBaseDir}/.trash/${name}";
      localTrashArg = lib.escapeShellArg localTrashPath;
      inherit (mount.bisync) checkFilename;
      checkFilenameArg = lib.escapeShellArg checkFilename;
      localCheckPath = "${localPath}/${checkFilename}";
      localCheckArg = lib.escapeShellArg localCheckPath;
      workdirPath = "/var/lib/r2-sync-${name}/bisync";
      workdirArg = lib.escapeShellArg workdirPath;
      layout = mkRemoteLayout mount;
      remoteArg = lib.escapeShellArg ":s3:${layout.path}";
      remoteTrashPath = ":s3:${mount.bucket}/.trash/${layout.prefix}";
      remoteTrashArg = lib.escapeShellArg remoteTrashPath;
      remoteCheckPath = ":s3:${layout.path}/${checkFilename}";
      remoteCheckArg = lib.escapeShellArg remoteCheckPath;
      # rclone bisync records this expiry in each run's lock file and renews it
      # while the run is alive, so a lock orphaned by a crash or shutdown is
      # auto-overridden by the next run once it lapses. Empty string omits the
      # flag (rclone default: locks never expire, wedging the service forever).
      maxLockArg = lib.optionalString (
        mount.bisync.maxLock != ""
      ) "--max-lock=${lib.escapeShellArg mount.bisync.maxLock}";
      compareArg = lib.optionalString (
        mount.bisync.compare != null
      ) "--compare=${lib.escapeShellArg mount.bisync.compare}";
      # rclone evaluates every --exclude before any --filter and gives --include
      # an implied trailing "- **", so the access-check file can only be pinned
      # ahead of user excludes when all rules share the --filter flag, where
      # the first matching rule wins.
      checkFileRule = "+ /${
        lib.escape [
          "\\"
          "*"
          "?"
          "["
          "]"
          "{"
          "}"
        ] checkFilename
      }";
      excludeRules = map (pattern: "- ${pattern}") mount.bisync.excludes;
      filterArgs = lib.optionalString (mount.bisync.excludes != [ ]) (
        lib.concatMapStringsSep " " (rule: "--filter=${lib.escapeShellArg rule}") (
          [ checkFileRule ] ++ excludeRules
        )
      );
      extraArgs = lib.escapeShellArgs mount.bisync.extraArgs;
      # rclone requires --resync after a filter change and recommends it after
      # a --compare change, but only guards --filters-file itself (an .md5
      # written next to the file, impossible from the store). The inline flags
      # are recorded in the workdir after each successful run so a change
      # forces the resync instead of a listing that silently drops files or
      # lacks the compared attribute. Of extraArgs, only the tracked filter
      # flags (trackedFilterArgs) are recorded.
      trackedFlags =
        lib.optional (mount.bisync.compare != null) "--compare=${mount.bisync.compare}"
        ++ map (rule: "--filter=${rule}") excludeRules
        ++ trackedFilterArgs mount.bisync.extraArgs;
      trackedFlagsArg = lib.escapeShellArg (lib.concatStringsSep "\n" trackedFlags);
      flagsFileArg = lib.escapeShellArg "${workdirPath}/.r2-bisync-flags";
      bisyncScript = pkgs.writeShellScript "r2-bisync-${name}" ''
        set -euo pipefail
        ${resolveAccountIdShell}
        endpoint="${runtimeEndpoint}"
        # Ensure the bisync access-check file exists on the remote before running.
        #
        # On S3/R2, rclone stores mtimes in metadata. Copying the local check file to
        # the remote path keeps the remote mtime stable (no drift), which avoids
        # bisync safety aborts like "all files were changed on Path2".
        ${pkgs.rclone}/bin/rclone copyto \
          --config=/dev/null \
          --s3-provider=Cloudflare \
          --s3-endpoint="$endpoint" \
          --s3-env-auth \
          --s3-no-check-bucket \
          ${localCheckArg} \
          ${remoteCheckArg}

        # First run requires an explicit resync to seed bisync state.
        resync_flags=()
        has_bisync_state=false
        if ${pkgs.coreutils}/bin/ls -1 ${workdirArg}/*.lst >/dev/null 2>&1; then
          has_bisync_state=true
        else
          resync_flags=(--resync --resync-mode ${lib.escapeShellArg mount.bisync.initialResyncMode})
        fi

        # Compare and filter flags recorded by the last successful run. A missing
        # file reads as the empty flag set, which is what every run before the
        # file existed used, so an unchanged default config never resyncs.
        current_flags=${trackedFlagsArg}
        stored_flags=""
        if [[ -f ${flagsFileArg} ]]; then
          stored_flags="$(< ${flagsFileArg})"
        fi
        if [[ "$has_bisync_state" == true ]] && [[ "$stored_flags" != "$current_flags" ]]; then
          echo "Bisync compare/filter flags for ${name} changed since the last successful run; running --resync as rclone requires after a filter change." >&2
          resync_flags=(--resync --resync-mode ${lib.escapeShellArg mount.bisync.initialResyncMode})
        fi

        record_flags() {
          printf '%s\n' "$current_flags" > ${flagsFileArg}
        }

        run_bisync() {
          ${pkgs.rclone}/bin/rclone bisync \
            --config=/dev/null \
            --s3-provider=Cloudflare \
            --s3-endpoint="$endpoint" \
            --s3-env-auth \
            --s3-no-check-bucket \
            ${localPathArg} ${remoteArg} \
            --backup-dir1=${localTrashArg} \
            --backup-dir2=${remoteTrashArg} \
            --max-delete=${toString mount.bisync.maxDelete} \
            ${maxLockArg} \
            --recover \
            --resilient \
            --workdir=${workdirArg} \
            --check-access \
            --check-filename=${checkFilenameArg} \
            ${compareArg} \
            ${filterArgs} \
            ${extraArgs} \
            "$@"
        }

        set +e
        bisync_output="$(run_bisync "''${resync_flags[@]}" 2>&1)"
        bisync_status=$?
        set -e

        if [[ "$bisync_status" -eq 0 ]]; then
          printf '%s\n' "$bisync_output"
          record_flags
          exit 0
        fi

        printf '%s\n' "$bisync_output" >&2

        # A crash or shutdown can orphan a .lck that then blocks every later run
        # with "prior lock file found". The workdir is host-local and
        # single-writer, so clearing a lock whose holder PID is dead and retrying
        # once is safe. Gated on --max-lock: with maxLock = "" the user opts into
        # rclone's native never-expire locks, which must be cleared by hand.
        # The match is rclone log text (cmd/bisync/lockfile.go), not an API:
        # re-check it on every pkgs.rclone bump.
        if [[ -n "${maxLockArg}" ]] \
          && [[ "$bisync_output" == *"prior lock file found"* ]]; then
          cleared_lock=false
          # rclone writes .lck as compact JSON with a quoted string PID
          # ("PID":"12345"); tolerate whitespace and unquoted ints against drift.
          pid_regex='"PID"[[:space:]]*:[[:space:]]*"?([0-9]+)"?'
          for lock_file in ${workdirArg}/*.lck; do
            [[ -f "$lock_file" ]] || continue
            lock_pid=""
            lock_content="$(< "$lock_file")" || true
            if [[ "$lock_content" =~ $pid_regex ]]; then
              lock_pid="''${BASH_REMATCH[1]}"
            fi
            # /proc/<pid> liveness (Linux-only) avoids kill -0's EPERM misfire
            # if the unit ever runs non-root. --max-lock is the real expiry.
            if [[ -z "$lock_pid" ]] || [[ ! -d "/proc/$lock_pid" ]]; then
              echo "Clearing orphaned bisync lock for ${name} (holder PID ''${lock_pid:-unknown} not running): $lock_file" >&2
              ${pkgs.coreutils}/bin/rm -f "$lock_file"
              cleared_lock=true
            else
              echo "Bisync lock for ${name} held by live PID $lock_pid; leaving it in place." >&2
            fi
          done
          if [[ "$cleared_lock" == true ]]; then
            echo "Retrying bisync for ${name} after clearing orphaned lock." >&2
            run_bisync "''${resync_flags[@]}"
            record_flags
            exit 0
          fi
        fi

        # When a mount path or remote basename changes, old listing files may still
        # exist in workdir and bisync asks for manual --resync recovery.
        # The matches are rclone log text (cmd/bisync/operations.go), not an
        # API: re-check them on every pkgs.rclone bump.
        if [[ "$has_bisync_state" == true ]] \
          && [[ "''${#resync_flags[@]}" -eq 0 ]] \
          && { [[ "$bisync_output" == *"cannot find prior Path1 or Path2 listings"* ]] || [[ "$bisync_output" == *"Must run --resync to recover"* ]]; }; then
          echo "Detected stale bisync listing state for ${name}; retrying once with --resync." >&2
          run_bisync --resync --resync-mode ${lib.escapeShellArg mount.bisync.initialResyncMode}
          record_flags
          exit 0
        fi

        exit "$bisync_status"
      '';
    in
    {
      name = "r2-bisync-${name}";
      value = {
        description = "R2 bisync for ${name}";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        preStart = ''
          ${pkgs.coreutils}/bin/mkdir -p ${localPathArg}
          ${pkgs.coreutils}/bin/mkdir -p ${lib.escapeShellArg localBaseDir}/.trash
          ${pkgs.coreutils}/bin/mkdir -p ${localTrashArg}
          ${pkgs.coreutils}/bin/mkdir -p ${workdirArg}
          ${pkgs.coreutils}/bin/test -e ${localCheckArg} || ${pkgs.coreutils}/bin/touch ${localCheckArg}
        '';
        serviceConfig = {
          Type = "oneshot";
          # A oneshot unit has no start timeout unless one is set, so a hung
          # run would otherwise block every later timer run without failing.
          TimeoutStartSec = if mount.bisync.timeout == "" then "infinity" else mount.bisync.timeout;
          # rclone bisync takes up to 90s to cancel and save its listings,
          # also when TimeoutStartSec expires and systemd stops the run.
          TimeoutStopSec = "2min";
          EnvironmentFile = cfg.credentialsFile;
          ExecStart = bisyncScript;
          StateDirectory = "r2-sync-${name}";
          NoNewPrivileges = true;
          PrivateTmp = true;
          ProtectKernelTunables = true;
          ProtectKernelModules = true;
          ProtectControlGroups = true;
          RestrictSUIDSGID = true;
          LockPersonality = true;
        };
      };
    };

  mkBisyncTimer = name: mount: {
    name = "r2-bisync-${name}";
    value = {
      description = "R2 bisync timer for ${name}";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        # Use OnActiveSec (not OnBootSec) so enabling the timer on an already-booted
        # system doesn't trigger an immediate run during `nixos-rebuild switch`.
        OnActiveSec = "2m";
        OnUnitActiveSec = mount.syncInterval;
        # All mount timers activate together; spread their R2 API bursts.
        RandomizedDelaySec = "30s";
        Unit = "r2-bisync-${name}.service";
        # No Persistent=true here: it only applies to OnCalendar= timers and is
        # a no-op for monotonic OnActiveSec/OnUnitActiveSec schedules.
      };
    };
  };
in
{
  options.services.r2-sync = {
    enable = lib.mkEnableOption "R2 mount and sync service";

    credentialsFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Path to env file with R2 credentials";
      example = "/run/secrets/r2/credentials.env";
    };

    accountId = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Cloudflare account ID";
      example = "abc123def456";
    };

    accountIdFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Path to file containing Cloudflare account ID";
      example = "/run/secrets/r2/account-id";
    };

    mounts = lib.mkOption {
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            bucket = lib.mkOption {
              type = lib.types.str;
              description = "R2 bucket name";
              example = "documents";
            };

            remotePrefix = lib.mkOption {
              type = lib.types.str;
              default = "";
              description = ''
                Required path prefix inside the bucket to use as the mount/sync
                root. Must normalize to a non-empty prefix (bare or repeated
                slashes are rejected) so the bisync trash backup-dir stays
                outside the sync root.
              '';
              example = "workspace";
            };

            mountPoint = lib.mkOption {
              type = lib.types.path;
              description = "Local mount path";
              example = "/mnt/r2/documents";
            };

            localPath = lib.mkOption {
              type = lib.types.nullOr lib.types.path;
              default = null;
              description = "Local path for bisync. Must be set to a directory different from mountPoint (bisync must not run against the live FUSE mount); enforced by assertion.";
              example = "/var/lib/r2-sync/documents";
            };

            syncInterval = lib.mkOption {
              type = lib.types.str;
              default = "5m";
              description = "Bisync interval in systemd time format";
            };

            vfsCache = {
              mode = lib.mkOption {
                type = lib.types.enum [
                  "off"
                  "minimal"
                  "writes"
                  "full"
                ];
                default = "full";
                description = "rclone VFS cache mode";
              };

              maxSize = lib.mkOption {
                type = lib.types.str;
                default = "10G";
                description = "rclone VFS cache size limit";
              };

              maxAge = lib.mkOption {
                type = lib.types.str;
                default = "24h";
                description = "rclone VFS cache max age";
              };
            };

            bisync = {
              maxDelete = lib.mkOption {
                type = lib.types.ints.between 0 100;
                default = 50;
                description = ''
                  Percentage (0-100) of files allowed to be deleted in a
                  single bisync run, passed to rclone bisync --max-delete.
                  This is not a count: if a run would delete more than this
                  percentage of the tracked files (for example because a
                  listing came back empty), bisync aborts without touching
                  anything. rclone itself silently clamps any value above 100
                  to 100, which disables the check entirely, so this option's
                  type rejects out-of-range values at eval time instead of
                  forwarding them. Recovery from a tripped check is a
                  deliberate manual `rclone bisync ... --force` run after
                  inspecting why so many deletes were expected.
                '';
              };

              checkFilename = lib.mkOption {
                type = lib.types.str;
                default = ".r2-check";
                description = "Filename used for rclone bisync --check-access safety checks (created locally and ensured remotely).";
              };

              initialResyncMode = lib.mkOption {
                type = lib.types.enum [
                  "path1"
                  "path2"
                  "newer"
                  "older"
                  "larger"
                  "smaller"
                ];
                default = "path1";
                description = "Resync preference used automatically on first run (when bisync state is missing).";
              };

              maxLock = lib.mkOption {
                type = lib.types.str;
                default = "15m";
                example = "5m";
                description = ''
                  Lock-file expiry passed to rclone bisync as --max-lock. rclone
                  renews the lock while a run is alive, so a run orphaned by a
                  crash or shutdown is auto-overridden by the next run once this
                  expiry lapses. The empty string omits --max-lock, restoring
                  rclone's default where locks never expire and an orphaned lock
                  wedges the service until cleared by hand. rclone enforces a 2m
                  minimum when the flag is set.
                '';
              };

              timeout = lib.mkOption {
                type = lib.types.str;
                default = "24h";
                example = "72h";
                description = ''
                  Deadline for one bisync run, passed as TimeoutStartSec to the
                  oneshot r2-bisync-<name> service, which systemd otherwise
                  starts with no start timeout at all. A run still going at the
                  deadline (for example one hung on a stuck network mount,
                  which --max-lock and --resilient do not bound) is stopped and
                  the unit fails, so the hang is visible and the timer can
                  start the next run. The empty string passes "infinity",
                  leaving a run unbounded. A first --resync of a very large
                  prefix can need more than the default.
                '';
              };

              compare = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                example = "size,checksum";
                description = ''
                  Comma-separated attributes bisync compares, passed as
                  --compare (any of size, modtime, checksum). null keeps
                  rclone's default of size,modtime. On S3-class backends the
                  modtime lives in object metadata and costs one HEAD request
                  per object on every listing, so "size,checksum" turns the
                  listing of a large prefix into a plain object walk (the ETag
                  is the MD5 for single-part uploads) at the price of hashing
                  the local tree each run. Changing this on a mount with
                  existing bisync state triggers one automatic --resync.
                '';
              };

              excludes = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
                example = [
                  "node_modules/**"
                  ".venv/**"
                ];
                description = ''
                  rclone filter patterns (rclone filtering syntax, relative to
                  the sync root). Each entry becomes a "- <pattern>" filter
                  rule on every bisync run, evaluated after a
                  "+ /<checkFilename>" rule that keeps the access-check file in
                  both listings whatever the patterns match. Changing this on a
                  mount with existing bisync state triggers one automatic
                  --resync, which rclone requires after a filter change.
                '';
              };

              extraArgs = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
                example = [
                  "--fast-list"
                  "--checkers"
                  "16"
                ];
                description = ''
                  Extra arguments appended verbatim to every rclone bisync
                  invocation after the module-managed flags, one argv element
                  per entry. Filter-shaped flags (--filter, --exclude,
                  --include, --filters-file, --files-from, and related forms,
                  or -f in any short form: -f X, -f=X, -fX, or a shorthand
                  cluster such as -vf) and the --metadata-*-from rules files
                  are rejected here by assertion; use excludes instead so the
                  change is tracked for the automatic --resync. Because -f may
                  carry its value attached, a separate option value that
                  starts with a single "-" and contains "f" is read as -f too:
                  pass such a value as --flag=value. The other listing filters
                  (--min-size, --max-size, --min-age, --max-age, --max-depth,
                  --hash-filter, --metadata-filter, --metadata-exclude,
                  --metadata-include, --ignore-case) are accepted and recorded
                  with their values, so changing one triggers the same
                  automatic --resync as an excludes change.
                '';
              };
            };
          };
        }
      );
      default = { };
      description = "R2 bucket mounts and sync definitions";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.credentialsFile != null;
        message = "services.r2-sync.credentialsFile must be set when services.r2-sync.enable = true";
      }
      {
        assertion = cfg.accountId != "" || cfg.accountIdFile != null;
        message = "services.r2-sync.accountId or services.r2-sync.accountIdFile must be set when services.r2-sync.enable = true";
      }
      {
        assertion = hasMounts;
        message = "services.r2-sync.mounts must define at least one mount when services.r2-sync.enable = true";
      }
    ]
    ++ lib.mapAttrsToList (name: mount: {
      assertion = mount.bucket != "";
      message = "services.r2-sync.mounts.${name}.bucket must be a non-empty string";
    }) cfg.mounts
    ++ lib.mapAttrsToList (name: mount: {
      assertion = mount.bucket == "" || r2lib.isValidBucketName mount.bucket;
      message = "services.r2-sync.mounts.${name}.bucket must be a valid R2 bucket name (3-63 lowercase letters, digits, or hyphens; must start and end with a letter or digit): got '${mount.bucket}'";
    }) cfg.mounts
    ++ lib.mapAttrsToList (name: mount: {
      assertion = r2lib.normalizeRemotePrefix mount.remotePrefix != "";
      message = "services.r2-sync.mounts.${name}.remotePrefix must be non-empty after normalization (required for bisync trash backup-dir outside sync root): got '${mount.remotePrefix}'";
    }) cfg.mounts
    ++ lib.mapAttrsToList (
      name: mount:
      let
        normalized = r2lib.normalizeRemotePrefix mount.remotePrefix;
      in
      {
        # The remote backup-dir lives at <bucket>/.trash/<remotePrefix>. A
        # prefix equal to or nested under .trash would place the backup-dir
        # inside the sync root, violating rclone bisync's non-overlap rule at
        # runtime, so reject it at eval time.
        assertion = normalized != ".trash" && !lib.hasPrefix ".trash/" normalized;
        message = "services.r2-sync.mounts.${name}.remotePrefix must not be '.trash' or nested under it (the bisync remote backup-dir '<bucket>/.trash/<remotePrefix>' must stay outside the sync root): got '${mount.remotePrefix}'";
      }
    ) cfg.mounts
    ++ lib.mapAttrsToList (name: mount: {
      assertion = mount.bisync.compare == null || isValidCompare mount.bisync.compare;
      message = "services.r2-sync.mounts.${name}.bisync.compare must be a comma-separated list of size, modtime, or checksum (rclone bisync --compare; null omits the flag): got '${toString mount.bisync.compare}'";
    }) cfg.mounts
    ++ lib.mapAttrsToList (name: _mount: {
      # The name is also the last path segment of the local trash directory
      # (localTrashPath), where "." or ".." would resolve to an ancestor.
      assertion = builtins.match "[A-Za-z0-9_.-]+" name != null && name != "." && name != "..";
      message = "services.r2-sync.mounts.${name} is not a valid mount name (must match [A-Za-z0-9_.-]+ so it can be used safely in a systemd unit name, and must not be '.' or '..', which would put the local bisync trash directory .trash/<name> outside itself): got '${name}'";
    }) cfg.mounts
    ++ lib.mapAttrsToList (name: mount: {
      assertion = !(pathsOverlap (resolveLocalPath mount) (toString mount.mountPoint));
      message = "services.r2-sync.mounts.${name}.localPath must not equal or be nested with mountPoint (bisync must not run against or through the live FUSE mount): set services.r2-sync.mounts.${name}.localPath to a separate local directory";
    }) cfg.mounts
    ++ lib.mapAttrsToList (name: mount: {
      assertion = !lib.any isBisyncFilterArg mount.bisync.extraArgs;
      message = "services.r2-sync.mounts.${name}.bisync.extraArgs must not contain filter flags (${lib.concatStringsSep ", " bisyncFilterFlagNames}, or -f alone, attached as -f=X or -fX, or in a shorthand cluster such as -vf; a separate option value that starts with a single '-' and contains 'f' reads as one, so pass it as --flag=value): put pattern rules in services.r2-sync.mounts.${name}.bisync.excludes and metadata rules in inline --metadata-filter, --metadata-exclude or --metadata-include flags, which are tracked for the automatic --resync";
    }) cfg.mounts
    ++ lib.mapAttrsToList (
      name: _mount:
      let
        mountUser = config.systemd.services."r2-mount-${name}".serviceConfig.User or "root";
      in
      {
        assertion = mountUser == "root" || mountUser == "" || config.programs.fuse.userAllowOther;
        message = "services.r2-sync.mounts.${name} runs r2-mount-${name}.service as non-root user '${mountUser}' without programs.fuse.userAllowOther = true (rclone mount passes --allow-other unconditionally, which requires user_allow_other for non-root mounts): set programs.fuse.userAllowOther = true";
      }
    ) cfg.mounts
    ++ map (
      pair:
      let
        layoutA = mkRemoteLayout pair.a.mount;
        layoutB = mkRemoteLayout pair.b.mount;
      in
      {
        assertion = !(pair.a.mount.bucket == pair.b.mount.bucket && layoutA.prefix == layoutB.prefix);
        message = "services.r2-sync.mounts.${pair.a.name} and services.r2-sync.mounts.${pair.b.name} both target bucket '${pair.a.mount.bucket}' prefix '${layoutA.prefix}': two mounts must not target the same remote tree";
      }
    ) mountPairs
    ++ map (
      pair:
      let
        layoutA = mkRemoteLayout pair.a.mount;
        layoutB = mkRemoteLayout pair.b.mount;
      in
      {
        assertion =
          !(
            pair.a.mount.bucket == pair.b.mount.bucket
            && layoutA.prefix != layoutB.prefix
            && pathsOverlap layoutA.prefix layoutB.prefix
          );
        message = "services.r2-sync.mounts.${pair.a.name} (bucket '${pair.a.mount.bucket}' prefix '${layoutA.prefix}') and services.r2-sync.mounts.${pair.b.name} (prefix '${layoutB.prefix}') have nested remote prefixes in the same bucket: concurrent bisync runs must not overlap trees";
      }
    ) mountPairs
    ++ lib.concatMap (
      pair:
      lib.concatMap (
        rootA:
        map (rootB: {
          assertion = !(pathsOverlap rootA.path rootB.path);
          message = "services.r2-sync.mounts.${pair.a.name}.${rootA.role} ('${rootA.path}') and services.r2-sync.mounts.${pair.b.name}.${rootB.role} ('${rootB.path}') overlap: each mount must use independent mountPoint and localPath directories";
        }) (localRoots pair.b.mount)
      ) (localRoots pair.a.mount)
    ) mountPairs;

    environment.systemPackages = [
      pkgs.rclone
      pkgs.fuse
    ];

    systemd.services =
      (lib.mapAttrs' mkMountService cfg.mounts) // (lib.mapAttrs' mkBisyncService cfg.mounts);

    systemd.timers = lib.mapAttrs' mkBisyncTimer cfg.mounts;
  };
}
