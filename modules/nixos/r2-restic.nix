{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.r2-restic;
  endpoint = "https://${cfg.accountId}.r2.cloudflarestorage.com";

  excludeFlags = lib.concatMapStringsSep " " (pattern: "--exclude=${lib.escapeShellArg pattern}") cfg.exclude;
  backupPaths = lib.concatMapStringsSep " " (path: lib.escapeShellArg (toString path)) cfg.paths;

  resticBackupScript = pkgs.writeShellScript "r2-restic-backup" ''
    set -euo pipefail

    ${pkgs.restic}/bin/restic backup \
      ${excludeFlags} \
      ${backupPaths}

    ${pkgs.restic}/bin/restic forget \
      --keep-daily ${toString cfg.retention.daily} \
      --keep-weekly ${toString cfg.retention.weekly} \
      --keep-monthly ${toString cfg.retention.monthly} \
      --keep-yearly ${toString cfg.retention.yearly} \
      --prune
  '';
in
{
  options.services.r2-restic = {
    enable = lib.mkEnableOption "Restic backups to R2";

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

    passwordFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Path to restic repository password file";
      example = "/run/secrets/restic-password";
    };

    bucket = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "R2 bucket for the restic repository";
      example = "backups";
    };

    paths = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      default = [ ];
      description = "Paths to back up";
      example = [
        "/home/user/important"
      ];
    };

    exclude = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Glob patterns to exclude from backup";
      example = [
        "*.tmp"
        ".cache"
      ];
    };

    schedule = lib.mkOption {
      type = lib.types.str;
      default = "daily";
      description = "Backup schedule in systemd calendar format";
      example = "daily";
    };

    retention = {
      daily = lib.mkOption {
        type = lib.types.int;
        default = 7;
        description = "Number of daily snapshots to keep";
      };
      weekly = lib.mkOption {
        type = lib.types.int;
        default = 4;
        description = "Number of weekly snapshots to keep";
      };
      monthly = lib.mkOption {
        type = lib.types.int;
        default = 12;
        description = "Number of monthly snapshots to keep";
      };
      yearly = lib.mkOption {
        type = lib.types.int;
        default = 3;
        description = "Number of yearly snapshots to keep";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.credentialsFile != null;
        message = "services.r2-restic.credentialsFile must be set when services.r2-restic.enable = true";
      }
      {
        assertion = cfg.accountId != "";
        message = "services.r2-restic.accountId must be set when services.r2-restic.enable = true";
      }
      {
        assertion = cfg.passwordFile != null;
        message = "services.r2-restic.passwordFile must be set when services.r2-restic.enable = true";
      }
      {
        assertion = cfg.bucket != "";
        message = "services.r2-restic.bucket must be set when services.r2-restic.enable = true";
      }
      {
        assertion = cfg.paths != [ ];
        message = "services.r2-restic.paths must contain at least one path when services.r2-restic.enable = true";
      }
      {
        assertion =
          cfg.retention.daily >= 0
          && cfg.retention.weekly >= 0
          && cfg.retention.monthly >= 0
          && cfg.retention.yearly >= 0;
        message = "services.r2-restic.retention values must be >= 0";
      }
    ];

    systemd.services.r2-restic-backup = {
      description = "Restic backup to R2";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      environment = {
        RESTIC_REPOSITORY = "s3:${endpoint}/${cfg.bucket}";
        RESTIC_PASSWORD_FILE = toString cfg.passwordFile;
      };

      serviceConfig = {
        Type = "oneshot";
        EnvironmentFile = cfg.credentialsFile;
        ExecStart = resticBackupScript;
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
      };
    };

    systemd.timers.r2-restic-backup = {
      description = "Restic backup timer";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = cfg.schedule;
        Persistent = true;
        RandomizedDelaySec = "1h";
      };
    };
  };
}
