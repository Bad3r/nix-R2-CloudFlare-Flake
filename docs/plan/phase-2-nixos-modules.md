# Phase 2: NixOS modules

## Module Specifications

### 1. NixOS Module: r2-sync.nix

```nix
{ config, lib, pkgs, ... }:
let
  cfg = config.services.r2-sync;
in
{
  options.services.r2-sync = {
    enable = lib.mkEnableOption "R2 mount and sync service";

    credentialsFile = lib.mkOption {
      type = lib.types.path;
      description = "Path to env file with R2 credentials";
      example = "/run/secrets/r2/credentials.env";
    };

    accountId = lib.mkOption {
      type = lib.types.str;
      description = "Cloudflare account ID";
    };

    accountIdFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Path to file containing Cloudflare account ID";
      example = "/run/secrets/r2/account-id";
    };

    mounts = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule {
        options = {
          bucket = lib.mkOption {
            type = lib.types.str;
            description = "R2 bucket name";
          };

          mountPoint = lib.mkOption {
            type = lib.types.path;
            description = "Local mount path";
            example = "/mnt/r2/documents";
          };

          localPath = lib.mkOption {
            type = lib.types.nullOr lib.types.path;
            default = null;
            description = "Local path for bisync (if different from mountPoint)";
          };

          syncInterval = lib.mkOption {
            type = lib.types.str;
            default = "5m";
            description = "Bisync interval (systemd OnUnitActiveSec format)";
          };

          trashRetention = lib.mkOption {
            type = lib.types.int;
            default = 30;
            description = "Days to retain deleted files in .trash/";
          };

          vfsCache = {
            mode = lib.mkOption {
              type = lib.types.enum [ "off" "minimal" "writes" "full" ];
              default = "full";
            };
            maxSize = lib.mkOption {
              type = lib.types.str;
              default = "10G";
            };
            maxAge = lib.mkOption {
              type = lib.types.str;
              default = "24h";
            };
          };
        };
      });
      default = { };
      description = "R2 bucket mounts and sync configurations";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ pkgs.rclone pkgs.fuse ];

    # Generate mount and sync services for each configured mount
    systemd.services = lib.mapAttrs' (name: mount: {
      name = "r2-mount-${name}";
      value = {
        description = "R2 FUSE mount for ${name}";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        wantedBy = [ "multi-user.target" ];

        serviceConfig = {
          Type = "notify";
          EnvironmentFile = cfg.credentialsFile;
          ExecStart = ''
            ${pkgs.rclone}/bin/rclone mount \
              --config=/dev/null \
              --s3-provider=Cloudflare \
              --s3-endpoint=https://${cfg.accountId}.r2.cloudflarestorage.com \
              --s3-env-auth \
              --vfs-cache-mode=${mount.vfsCache.mode} \
              --vfs-cache-max-size=${mount.vfsCache.maxSize} \
              --vfs-cache-max-age=${mount.vfsCache.maxAge} \
              --allow-other \
              :s3:${mount.bucket} ${mount.mountPoint}
          '';
          ExecStop = "${pkgs.fuse}/bin/fusermount -u ${mount.mountPoint}";
          Restart = "on-failure";
          RestartSec = "5s";
        };

        preStart = "mkdir -p ${mount.mountPoint}";
      };
    }) cfg.mounts // lib.mapAttrs' (name: mount: {
      name = "r2-bisync-${name}";
      value = {
        description = "R2 bisync for ${name}";
        after = [ "r2-mount-${name}.service" ];
        requires = [ "r2-mount-${name}.service" ];

        serviceConfig = {
          Type = "oneshot";
          EnvironmentFile = cfg.credentialsFile;
          ExecStart = let
            localPath = if mount.localPath != null then mount.localPath else mount.mountPoint;
          in ''
            ${pkgs.rclone}/bin/rclone bisync \
              --config=/dev/null \
              --s3-provider=Cloudflare \
              --s3-endpoint=https://${cfg.accountId}.r2.cloudflarestorage.com \
              --s3-env-auth \
              ${localPath} :s3:${mount.bucket} \
              --backup-dir1=${localPath}/.trash \
              --backup-dir2=:s3:${mount.bucket}/.trash \
              --max-delete=50% \
              --check-access
          '';
        };
      };
    }) cfg.mounts;

    systemd.timers = lib.mapAttrs' (name: mount: {
      name = "r2-bisync-${name}";
      value = {
        description = "R2 bisync timer for ${name}";
        wantedBy = [ "timers.target" ];
        timerConfig = {
          OnBootSec = "2m";
          OnUnitActiveSec = mount.syncInterval;
          Unit = "r2-bisync-${name}.service";
        };
      };
    }) cfg.mounts;
  };
}
```

Credentials model note (system scope):

- Secrets live in `secrets/r2.yaml`.
- sops-nix extracts keys to `/run/secrets/r2/*`.
- sops templates render `/run/secrets/r2/credentials.env` for system services.

### 2. NixOS Module: r2-restic.nix

```nix
{ config, lib, pkgs, ... }:
let
  cfg = config.services.r2-restic;
in
{
  options.services.r2-restic = {
    enable = lib.mkEnableOption "Restic backups to R2";

    credentialsFile = lib.mkOption {
      type = lib.types.path;
      description = "Path to env file with R2 credentials";
    };

    accountId = lib.mkOption {
      type = lib.types.str;
      description = "Cloudflare account ID";
    };

    passwordFile = lib.mkOption {
      type = lib.types.path;
      description = "Path to restic repository password";
    };

    bucket = lib.mkOption {
      type = lib.types.str;
      description = "R2 bucket for restic repository";
    };

    paths = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      description = "Paths to back up";
    };

    exclude = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Patterns to exclude";
    };

    schedule = lib.mkOption {
      type = lib.types.str;
      default = "daily";
      description = "Backup schedule (systemd calendar format)";
    };

    retention = {
      daily = lib.mkOption { type = lib.types.int; default = 7; };
      weekly = lib.mkOption { type = lib.types.int; default = 4; };
      monthly = lib.mkOption { type = lib.types.int; default = 12; };
      yearly = lib.mkOption { type = lib.types.int; default = 3; };
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.r2-restic-backup = {
      description = "Restic backup to R2";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      environment = {
        RESTIC_REPOSITORY = "s3:https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}";
        RESTIC_PASSWORD_FILE = cfg.passwordFile;
      };

      serviceConfig = {
        Type = "oneshot";
        EnvironmentFile = cfg.credentialsFile;
        ExecStart = pkgs.writeShellScript "restic-backup" ''
          ${pkgs.restic}/bin/restic backup \
            ${lib.concatMapStringsSep " " (p: "--exclude='${p}'") cfg.exclude} \
            ${lib.concatStringsSep " " cfg.paths}

          ${pkgs.restic}/bin/restic forget \
            --keep-daily ${toString cfg.retention.daily} \
            --keep-weekly ${toString cfg.retention.weekly} \
            --keep-monthly ${toString cfg.retention.monthly} \
            --keep-yearly ${toString cfg.retention.yearly} \
            --prune
        '';
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
```

### 3. NixOS Module: git-annex.nix

Provides git-annex with R2 integration. This doesn't create services—it just ensures git-annex is available with proper rclone integration.

```nix
{ config, lib, pkgs, ... }:
let
  cfg = config.programs.git-annex-r2;

  # Helper script to initialize git-annex with R2 special remote
  git-annex-r2-init = pkgs.writeShellScriptBin "git-annex-r2-init" ''
    set -euo pipefail

    # Load R2 credentials
    if [[ -f "${cfg.credentialsFile}" ]]; then
      set -a; source "${cfg.credentialsFile}"; set +a
    fi

    ACCOUNT_ID="''${R2_ACCOUNT_ID:-}"
    [[ -z "$ACCOUNT_ID" ]] && { echo "Error: R2_ACCOUNT_ID not set"; exit 1; }

    remote_name="''${1:-r2}"
    bucket="''${2:-$(basename "$PWD")}"
    prefix="''${3:-annex/$bucket}"

    # Initialize git-annex if not already
    if ! git annex version &>/dev/null; then
      git annex init "$(hostname)"
    fi

    # Check if remote already exists
    if git annex info "$remote_name" &>/dev/null; then
      echo "Remote '$remote_name' already exists"
      exit 0
    fi

    # Initialize R2 as special remote
    git annex initremote "$remote_name" \
      type=rclone \
      rcloneremotename=r2 \
      rcloneprefix="$prefix" \
      encryption=none

    echo "Initialized R2 special remote:"
    echo "  Remote: $remote_name"
    echo "  Bucket: r2:$prefix"
    echo ""
    echo "Usage:"
    echo "  git annex add <large-files>    # Track with annex"
    echo "  git annex sync --content       # Sync to R2"
    echo "  git annex drop <file>          # Free local space"
    echo "  git annex get <file>           # Fetch from R2"
  '';
in
{
  options.programs.git-annex-r2 = {
    enable = lib.mkEnableOption "git-annex with R2 integration";

    credentialsFile = lib.mkOption {
      type = lib.types.path;
      description = "Path to R2 credentials env file";
      example = "/run/secrets/r2/credentials.env";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [
      pkgs.git-annex
      git-annex-r2-init
    ];
  };
}
```

**Usage:**

```bash
cd ~/projects/my-repo
git-annex-r2-init              # Uses defaults: remote=r2, bucket=my-repo
git-annex-r2-init cloud mybucket annex/custom-prefix  # Custom config

git annex add large-file.zip
git commit -m "Add large file"
git annex sync --content       # Pushes to R2
```
