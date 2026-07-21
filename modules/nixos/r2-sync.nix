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
      localPath = if mount.localPath != null then toString mount.localPath else toString mount.mountPoint;
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

        run_bisync() {
          ${pkgs.rclone}/bin/rclone bisync \
            --config=/dev/null \
            --s3-provider=Cloudflare \
            --s3-endpoint="$endpoint" \
            --s3-env-auth \
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
            "$@"
        }

        set +e
        bisync_output="$(run_bisync "''${resync_flags[@]}" 2>&1)"
        bisync_status=$?
        set -e

        if [[ "$bisync_status" -eq 0 ]]; then
          printf '%s\n' "$bisync_output"
          exit 0
        fi

        printf '%s\n' "$bisync_output" >&2

        # A lock file left by a run that was killed (host shutdown, OOM, crash)
        # blocks every later run with "prior lock file found". The bisync workdir
        # is host-local and single-writer, so a lock whose recorded holder PID is
        # no longer running is a safe orphan to clear, then retry once. --max-lock
        # auto-expires orphans written after it was set; this branch also recovers
        # locks written before it, whose stored expiry is far in the future.
        if [[ "$bisync_output" == *"prior lock file found"* ]]; then
          cleared_lock=false
          for lock_file in ${workdirArg}/*.lck; do
            [[ -f "$lock_file" ]] || continue
            lock_pid=""
            lock_content="$(< "$lock_file")" || true
            if [[ "$lock_content" =~ \"PID\":\"([0-9]+)\" ]]; then
              lock_pid="''${BASH_REMATCH[1]}"
            fi
            if [[ -z "$lock_pid" ]] || ! kill -0 "$lock_pid" 2>/dev/null; then
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
            exit 0
          fi
        fi

        # When a mount path or remote basename changes, old listing files may still
        # exist in workdir and bisync asks for manual --resync recovery.
        if [[ "$has_bisync_state" == true ]] \
          && [[ "''${#resync_flags[@]}" -eq 0 ]] \
          && { [[ "$bisync_output" == *"cannot find prior Path1 or Path2 listings"* ]] || [[ "$bisync_output" == *"Must run --resync to recover"* ]]; }; then
          echo "Detected stale bisync listing state for ${name}; retrying once with --resync." >&2
          run_bisync --resync --resync-mode ${lib.escapeShellArg mount.bisync.initialResyncMode}
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
              description = "Local path for bisync when different from mountPoint";
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
                type = lib.types.int;
                default = 100000;
                description = "Maximum number of deletes permitted per bisync run (rclone --max-delete)";
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
    ) cfg.mounts;

    environment.systemPackages = [
      pkgs.rclone
      pkgs.fuse
    ];

    systemd.services =
      (lib.mapAttrs' mkMountService cfg.mounts) // (lib.mapAttrs' mkBisyncService cfg.mounts);

    systemd.timers = lib.mapAttrs' mkBisyncTimer cfg.mounts;
  };
}
