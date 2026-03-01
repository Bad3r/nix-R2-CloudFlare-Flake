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

  mkMountService =
    name: mount:
    let
      mountPoint = toString mount.mountPoint;
      mountPointArg = lib.escapeShellArg mountPoint;
      remotePrefix =
        if mount.remotePrefix == "" then
          ""
        else
          lib.removePrefix "/" (lib.removeSuffix "/" mount.remotePrefix);
      remotePath = if remotePrefix == "" then mount.bucket else "${mount.bucket}/${remotePrefix}";
      remoteArg = lib.escapeShellArg ":s3:${remotePath}";
      mountScript = pkgs.writeShellScript "r2-mount-${name}" ''
        set -euo pipefail
        # rclone invokes `fusermount3` for FUSE mounts. On NixOS the setuid wrapper
        # lives in /run/wrappers/bin (the store binary is non-setuid and fails
        # with "Operation not permitted" for non-root mounts).
        export PATH="/run/wrappers/bin:$PATH"
        ${resolveAccountIdShell}
        endpoint="https://$R2_RESOLVED_ACCOUNT_ID.r2.cloudflarestorage.com"
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
          ExecStop = ''
            ${pkgs.util-linux}/bin/mountpoint -q ${mountPointArg} && \
              (/run/wrappers/bin/fusermount3 -u ${mountPointArg} || /run/wrappers/bin/fusermount -u ${mountPointArg} || /run/wrappers/bin/umount ${mountPointArg}) || true
          '';
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
      remotePrefix =
        if mount.remotePrefix == "" then
          ""
        else
          lib.removePrefix "/" (lib.removeSuffix "/" mount.remotePrefix);
      remotePath = if remotePrefix == "" then mount.bucket else "${mount.bucket}/${remotePrefix}";
      remoteArg = lib.escapeShellArg ":s3:${remotePath}";
      remoteTrashSuffix = remotePrefix;
      remoteTrashPath = ":s3:${mount.bucket}/.trash/${remoteTrashSuffix}";
      remoteTrashArg = lib.escapeShellArg remoteTrashPath;
      remoteCheckPath = ":s3:${remotePath}/${checkFilename}";
      remoteCheckArg = lib.escapeShellArg remoteCheckPath;
      bisyncScript = pkgs.writeShellScript "r2-bisync-${name}" ''
        set -euo pipefail
        ${resolveAccountIdShell}
        endpoint="https://$R2_RESOLVED_ACCOUNT_ID.r2.cloudflarestorage.com"
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
        Persistent = true;
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
              description = "Optional path prefix inside the bucket to use as the mount/sync root";
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

            trashRetention = lib.mkOption {
              type = lib.types.int;
              default = 30;
              description = "Retention policy hint for deleted files in .trash/";
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
      assertion = mount.remotePrefix != "";
      message = "services.r2-sync.mounts.${name}.remotePrefix must be non-empty (required for bisync trash backup-dir outside sync root)";
    }) cfg.mounts;

    environment.systemPackages = [
      pkgs.rclone
      pkgs.fuse
    ];

    systemd.services =
      (lib.mapAttrs' mkMountService cfg.mounts) // (lib.mapAttrs' mkBisyncService cfg.mounts);

    systemd.timers = lib.mapAttrs' mkBisyncTimer cfg.mounts;
  };
}
