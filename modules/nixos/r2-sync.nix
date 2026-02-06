{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.r2-sync;
  endpoint = "https://${cfg.accountId}.r2.cloudflarestorage.com";
  hasMounts = cfg.mounts != { };

  mkMountService =
    name: mount:
    let
      mountPoint = toString mount.mountPoint;
      mountPointArg = lib.escapeShellArg mountPoint;
      remoteArg = lib.escapeShellArg ":s3:${mount.bucket}";
      endpointArg = lib.escapeShellArg endpoint;
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
          ExecStart = ''
            ${pkgs.rclone}/bin/rclone mount \
              --config=/dev/null \
              --s3-provider=Cloudflare \
              --s3-endpoint=${endpointArg} \
              --s3-env-auth \
              --vfs-cache-mode=${mount.vfsCache.mode} \
              --vfs-cache-max-size=${lib.escapeShellArg mount.vfsCache.maxSize} \
              --vfs-cache-max-age=${lib.escapeShellArg mount.vfsCache.maxAge} \
              --cache-dir=/var/lib/r2-sync-${name}/cache \
              --allow-other \
              ${remoteArg} \
              ${mountPointArg}
          '';
          ExecStop = ''
            ${pkgs.util-linux}/bin/mountpoint -q ${mountPointArg} && \
              (${pkgs.fuse}/bin/fusermount -u ${mountPointArg} || ${pkgs.util-linux}/bin/umount ${mountPointArg}) || true
          '';
          Restart = "on-failure";
          RestartSec = "5s";
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

  mkBisyncService =
    name: mount:
    let
      localPath =
        if mount.localPath != null then
          toString mount.localPath
        else
          toString mount.mountPoint;
      localPathArg = lib.escapeShellArg localPath;
      localTrashArg = lib.escapeShellArg "${localPath}/.trash";
      remoteArg = lib.escapeShellArg ":s3:${mount.bucket}";
      remoteTrashArg = lib.escapeShellArg ":s3:${mount.bucket}/.trash";
      endpointArg = lib.escapeShellArg endpoint;
    in
    {
      name = "r2-bisync-${name}";
      value = {
        description = "R2 bisync for ${name}";
        after = [ "r2-mount-${name}.service" ];
        requires = [ "r2-mount-${name}.service" ];
        preStart = ''
          ${pkgs.coreutils}/bin/mkdir -p ${localPathArg}
          ${pkgs.coreutils}/bin/mkdir -p ${localTrashArg}
        '';
        serviceConfig = {
          Type = "oneshot";
          EnvironmentFile = cfg.credentialsFile;
          ExecStart = ''
            ${pkgs.rclone}/bin/rclone bisync \
              --config=/dev/null \
              --s3-provider=Cloudflare \
              --s3-endpoint=${endpointArg} \
              --s3-env-auth \
              ${localPathArg} ${remoteArg} \
              --backup-dir1=${localTrashArg} \
              --backup-dir2=${remoteTrashArg} \
              --max-delete=50% \
              --check-access
          '';
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
        OnBootSec = "2m";
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
      example = "/run/secrets/r2-credentials";
    };

    accountId = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Cloudflare account ID";
      example = "abc123def456";
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
        assertion = cfg.accountId != "";
        message = "services.r2-sync.accountId must be set when services.r2-sync.enable = true";
      }
      {
        assertion = hasMounts;
        message = "services.r2-sync.mounts must define at least one mount when services.r2-sync.enable = true";
      }
    ] ++ lib.mapAttrsToList (name: mount: {
      assertion = mount.bucket != "";
      message = "services.r2-sync.mounts.${name}.bucket must be a non-empty string";
    }) cfg.mounts;

    environment.systemPackages = [
      pkgs.rclone
      pkgs.fuse
    ];

    systemd.services = (lib.mapAttrs' mkMountService cfg.mounts) // (lib.mapAttrs' mkBisyncService cfg.mounts);

    systemd.timers = lib.mapAttrs' mkBisyncTimer cfg.mounts;
  };
}
