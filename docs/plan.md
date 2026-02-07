# r2-cloud-nix: Standalone R2 Cloud Storage Flake

## Overview

A self-contained Nix flake providing Cloudflare R2 cloud storage with:

- Easy bucket creation via CLI
- Local FUSE mount with 2-way background sync
- Version history tracking (git-annex + restic)
- Soft delete/trash with recovery
- Web interface for remote access and sharing (R2-Explorer)
- Authentication via Cloudflare Access

**This is a standalone repository** - completely independent from any existing NixOS configuration. Users import it as a flake input.

## Architecture

```mermaid
graph TB
    subgraph LOCAL["LOCAL SYSTEM"]
        MOUNT["rclone mount<br/>FUSE"]
        BISYNC["rclone bisync<br/>timer"]
        VERSION_GA["git-annex"]
        VERSION_R["restic"]

        MOUNT <--> BISYNC
        BISYNC <--> VERSION_GA
        BISYNC <--> VERSION_R
    end

    subgraph R2["CLOUDFLARE R2"]
        BUCKET["R2 Bucket"]
        FILES["files/<br/>synced data"]
        TRASH[".trash/<br/>soft-deleted<br/>30d lifecycle"]
        ANNEX[".git-annex/<br/>version metadata"]

        BUCKET --> FILES
        BUCKET --> TRASH
        BUCKET --> ANNEX
    end

    subgraph EDGE["CLOUDFLARE EDGE"]
        ACCESS["Cloudflare Access<br/>Zero Trust Auth"]
        WORKER["R2-Explorer Worker"]
        BROWSER["Web file browser"]
        UPLOAD["Upload/Download"]
        PREVIEW["File preview"]
        SHARE["Tokenized public<br/>share links"]
        DOMAIN["files.domain.com"]

        ACCESS <--> WORKER
        DOMAIN <--> WORKER
        WORKER --> BROWSER
        WORKER --> UPLOAD
        WORKER --> PREVIEW
        WORKER --> SHARE
    end

    MOUNT --> BUCKET
    BISYNC --> BUCKET
    VERSION_GA --> BUCKET
    VERSION_R --> BUCKET
    BUCKET --> WORKER

    style LOCAL fill:#1c2128,stroke:#539bf5,stroke-width:2px,color:#adbac7
    style R2 fill:#1c2128,stroke:#d29922,stroke-width:2px,color:#adbac7
    style EDGE fill:#1c2128,stroke:#b083f0,stroke-width:2px,color:#adbac7
    style MOUNT fill:#2d333b,stroke:#539bf5,color:#adbac7
    style BISYNC fill:#2d333b,stroke:#539bf5,color:#adbac7
    style VERSION_GA fill:#2d333b,stroke:#539bf5,color:#adbac7
    style VERSION_R fill:#2d333b,stroke:#539bf5,color:#adbac7
    style BUCKET fill:#2d333b,stroke:#d29922,color:#adbac7
    style FILES fill:#2d333b,stroke:#d29922,color:#adbac7
    style TRASH fill:#2d333b,stroke:#d29922,color:#adbac7
    style ANNEX fill:#2d333b,stroke:#d29922,color:#adbac7
    style ACCESS fill:#2d333b,stroke:#b083f0,color:#adbac7
    style WORKER fill:#2d333b,stroke:#b083f0,color:#adbac7
    style BROWSER fill:#2d333b,stroke:#b083f0,color:#adbac7
    style UPLOAD fill:#2d333b,stroke:#b083f0,color:#adbac7
    style PREVIEW fill:#2d333b,stroke:#b083f0,color:#adbac7
    style SHARE fill:#2d333b,stroke:#b083f0,color:#adbac7
    style DOMAIN fill:#2d333b,stroke:#b083f0,color:#adbac7
```

## Understanding git-annex (Key Design Decision)

**git-annex is NOT for separate "document buckets"** - it manages large files **within the same git repo** as your code/documents.

**How it works:**

1. In any git repo, `git annex add <large-file>` replaces the file with a symlink
2. The actual content is stored in `.git/annex/objects/` (content-addressed)
3. Git tracks the symlink (small), not the large file content
4. Content syncs to "special remotes" (R2 via rclone) with `git annex sync --content`
5. `git annex get <file>` downloads content; `git annex drop <file>` frees local space

**Example workflow:**

```bash
# In any project with large files
cd ~/projects/video-editing
git init && git annex init "laptop"

# Add R2 as special remote (uses your existing rclone r2 config)
git annex initremote r2 type=rclone \
  rcloneremotename=r2 \
  rcloneprefix=annex/video-editing \
  encryption=none

# Track large files with annex (code stays in git)
git annex add *.mp4 *.mov raw-footage/
git add *.py *.md   # Code/docs tracked normally by git
git commit -m "Initial commit"

# Sync content to R2
git annex sync --content

# Later, free local space
git annex drop raw-footage/  # Content still in R2
git annex get raw-footage/clip1.mp4  # Fetch when needed
```

**Key benefit**: One repo, one bucket prefix, mixed content (code + large files).

**Three sync strategies in this flake:**

| Strategy          | Use Case                            | How It Works                                    |
| ----------------- | ----------------------------------- | ----------------------------------------------- |
| **git-annex**     | Git repos with large files          | Symlinks + special remotes, per-file versioning |
| **rclone bisync** | Non-git folders (Downloads, Photos) | 2-way sync, --backup-dir for trash              |
| **rclone mount**  | Direct R2 access                    | FUSE mount with VFS cache                       |

Sources:

- [git-annex walkthrough](https://git-annex.branchable.com/walkthrough/)
- [rclone special remote](https://git-annex.branchable.com/special_remotes/rclone/)
- [rclone gitannex command](https://rclone.org/commands/rclone_gitannex/)

## Repository Structure

```
r2-cloud-nix/
├── flake.nix                    # Main flake definition
├── flake.lock
├── default.nix                  # Compatibility for non-flake users
│
├── modules/
│   ├── nixos/
│   │   ├── default.nix          # Aggregates all NixOS modules
│   │   ├── r2-sync.nix          # Mount + bisync systemd services
│   │   ├── r2-restic.nix        # Restic snapshots to R2
│   │   └── git-annex.nix        # git-annex with R2 special remote
│   │
│   └── home-manager/
│       ├── default.nix          # Aggregates all HM modules
│       ├── r2-credentials.nix   # Credentials management
│       ├── r2-cli.nix           # CLI integration wrappers (env/default injection)
│       └── rclone-config.nix    # rclone remote configuration
│
├── packages/
│   └── r2-cli.nix               # Primary `r2` subcommand CLI
│
├── lib/
│   └── r2.nix                   # Shared library functions
│
├── r2-explorer/                 # Cloudflare Worker subflake
│   ├── flake.nix
│   ├── package.json
│   ├── pnpm-lock.yaml
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── wrangler.toml
│   ├── src/
│   │   ├── index.ts             # Worker entry point
│   │   ├── app.ts               # Hono app + route handlers
│   │   ├── schemas.ts           # Zod request/response contracts
│   │   ├── auth.ts              # Access/HMAC auth helpers
│   │   ├── kv.ts                # Share KV state operations
│   │   ├── r2.ts                # R2 object operations
│   │   ├── http.ts              # Error/response helpers
│   │   ├── ui.ts                # Embedded dashboard UI
│   │   ├── types.ts             # Worker environment/types
│   │   └── version.ts
│   ├── tests/
│   │   ├── auth.spec.ts
│   │   ├── share.spec.ts
│   │   ├── multipart.spec.ts
│   │   ├── readonly.spec.ts
│   │   ├── server-info.spec.ts
│   │   └── helpers/
│   │       └── memory.ts
│   └── .github/
│       └── workflows/
│           └── deploy.yml       # Phase 7 hardening target
│
├── templates/
│   ├── minimal/                 # Minimal setup template
│   │   └── flake.nix
│   └── full/                    # Full setup with all features
│       └── flake.nix
│
├── docs/
│   ├── quickstart.md
│   ├── credentials.md
│   ├── sync.md
│   ├── versioning.md
│   └── sharing.md
│
└── README.md
```

## Flake Definition

```nix
# flake.nix
{
  description = "Cloudflare R2 cloud storage with sync, versioning, and sharing";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs = inputs @ { self, nixpkgs, home-manager, flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];

      flake = {
        # NixOS modules
        nixosModules = {
          default = import ./modules/nixos;
          r2-sync = import ./modules/nixos/r2-sync.nix;
          r2-restic = import ./modules/nixos/r2-restic.nix;
          git-annex = import ./modules/nixos/git-annex.nix;
        };

        # Home Manager modules
        homeManagerModules = {
          default = import ./modules/home-manager;
          r2-credentials = import ./modules/home-manager/r2-credentials.nix;
          r2-cli = import ./modules/home-manager/r2-cli.nix;
          rclone-config = import ./modules/home-manager/rclone-config.nix;
        };

        # Project templates
        templates = {
          minimal = {
            path = ./templates/minimal;
            description = "Minimal R2 sync setup";
          };
          full = {
            path = ./templates/full;
            description = "Full R2 setup with versioning and web UI";
          };
        };

        # Library functions
        lib = import ./lib/r2.nix { inherit (nixpkgs) lib; };
      };

      perSystem = { pkgs, system, ... }: {
        # CLI packages
        packages = {
          r2 = pkgs.callPackage ./packages/r2-cli.nix { };
          default = pkgs.symlinkJoin {
            name = "r2-cloud-tools";
            paths = [
              self.packages.${system}.r2
            ];
          };
        };

        # Development shell
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            rclone
            restic
            git-annex
            nodePackages.wrangler
            nodejs
            jq
          ];
        };

        # Formatter
        formatter = pkgs.nixfmt-rfc-style;
      };
    };
}
```

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
      example = "/run/secrets/r2-credentials";
    };

    accountId = lib.mkOption {
      type = lib.types.str;
      description = "Cloudflare account ID";
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
      example = "/run/secrets/r2-credentials";
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

### 4. Home Manager Module: r2-cli.nix

```nix
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.r2-cloud;
in
{
  options.programs.r2-cloud = {
    enable = lib.mkEnableOption "R2 cloud CLI helpers";

    accountId = lib.mkOption { type = lib.types.str; default = ""; };
    credentialsFile = lib.mkOption { type = lib.types.path; default = "${config.xdg.configHome}/cloudflare/r2/env"; };
    enableRcloneRemote = lib.mkOption { type = lib.types.bool; default = true; };
    rcloneRemoteName = lib.mkOption { type = lib.types.str; default = "r2"; };
    rcloneConfigPath = lib.mkOption { type = lib.types.path; default = "${config.xdg.configHome}/rclone/rclone.conf"; };
    installTools = lib.mkOption { type = lib.types.bool; default = true; };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      { assertion = cfg.accountId != ""; message = "programs.r2-cloud.accountId must be set when programs.r2-cloud.enable = true"; }
      { assertion = cfg.rcloneRemoteName != "" || !cfg.enableRcloneRemote; message = "programs.r2-cloud.rcloneRemoteName must be non-empty when remote generation is enabled"; }
    ];

    # Installs wrapped CLI from package derivation:
    # - r2 (primary package-backed subcommand CLI)
    #
    # HM wrappers only inject default env/config and delegate to package binaries.
    home.packages = [ r2Wrapper ];
  };
}
```

Phase 4 extracts operational CLI logic into `packages/` derivations so it can be used directly via
`nix run` and reused by Home Manager wrappers. The HM module remains declarative and enforces
strict validation while injecting configuration defaults (`R2_CREDENTIALS_FILE`, `R2_RCLONE_CONFIG`,
`R2_DEFAULT_ACCOUNT_ID`).

### 5. Home Manager Module: r2-credentials.nix

```nix
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.r2-cloud.credentials;
  effectiveAccountId =
    if cfg.accountId != "" then cfg.accountId else config.programs.r2-cloud.accountId;
in
{
  options.programs.r2-cloud.credentials = {
    manage = lib.mkEnableOption "Manage R2 credentials env file";
    accountId = lib.mkOption { type = lib.types.str; default = ""; };
    accessKeyIdFile = lib.mkOption { type = lib.types.nullOr lib.types.path; default = null; };
    secretAccessKeyFile = lib.mkOption { type = lib.types.nullOr lib.types.path; default = null; };
    outputFile = lib.mkOption { type = lib.types.path; default = "${config.xdg.configHome}/cloudflare/r2/env"; };
  };

  config = lib.mkIf cfg.manage {
    assertions = [
      { assertion = effectiveAccountId != ""; message = "R2 account ID must be set for credential management"; }
      { assertion = cfg.accessKeyIdFile != null; message = "accessKeyIdFile is required when manage = true"; }
      { assertion = cfg.secretAccessKeyFile != null; message = "secretAccessKeyFile is required when manage = true"; }
    ];

    # Builds credentials file from secret file inputs (sops-nix/agenix/etc)
    home.activation.r2-cloud-credentials = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      set -euo pipefail
      # mkdir, write file, chmod 0400
      # R2_ACCOUNT_ID=...
      # AWS_ACCESS_KEY_ID=...
      # AWS_SECRET_ACCESS_KEY=...
    '';
  };
}
```

### 6. Home Manager Module: rclone-config.nix

```nix
{ config, lib, ... }:
let
  cfg = config.programs.r2-cloud;
in
{
  config = lib.mkIf (cfg.enable && cfg.enableRcloneRemote) {
    assertions = [
      # rcloneConfigPath must be under config.xdg.configHome
      # accountId must be non-empty
    ];

    xdg.configFile."rclone/rclone.conf".text = ''
      [${cfg.rcloneRemoteName}]
      type = s3
      provider = Cloudflare
      env_auth = true
      endpoint = https://${cfg.accountId}.r2.cloudflarestorage.com
    '';
  };
}
```

## Usage Examples

### Minimal Setup (Consumer's flake.nix)

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager.url = "github:nix-community/home-manager";
    r2-cloud.url = "github:username/r2-cloud-nix";
  };

  outputs = { nixpkgs, home-manager, r2-cloud, ... }: {
    nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
      modules = [
        r2-cloud.nixosModules.default
        {
          services.r2-sync = {
            enable = true;
            accountId = "abc123def456";
            credentialsFile = "/run/secrets/r2-credentials";
            mounts.documents = {
              bucket = "my-documents";
              mountPoint = "/mnt/r2/documents";
              syncInterval = "10m";
            };
          };
        }
      ];
    };

    homeConfigurations.myuser = home-manager.lib.homeManagerConfiguration {
      modules = [
        r2-cloud.homeManagerModules.default
        {
          programs.r2-cloud = {
            enable = true;
            accountId = "abc123def456";
          };
        }
      ];
    };
  };
}
```

### Full Setup with Restic

```nix
{
  services.r2-sync = {
    enable = true;
    accountId = "abc123def456";
    credentialsFile = "/run/secrets/r2-credentials";

    mounts = {
      documents = {
        bucket = "documents";
        mountPoint = "/mnt/r2/documents";
        syncInterval = "5m";
      };
      photos = {
        bucket = "photos";
        mountPoint = "/mnt/r2/photos";
        syncInterval = "15m";
        vfsCache.maxSize = "20G";
      };
    };
  };

  services.r2-restic = {
    enable = true;
    accountId = "abc123def456";
    credentialsFile = "/run/secrets/r2-credentials";
    passwordFile = "/run/secrets/restic-password";
    bucket = "backups";
    paths = [ "/home/user/important" "/mnt/r2/documents" ];
    exclude = [ "*.tmp" ".cache" "node_modules" ];
    schedule = "daily";
    retention = {
      daily = 7;
      weekly = 4;
      monthly = 12;
    };
  };
}
```

## R2-Explorer Subflake

The `r2-explorer/` directory is an independent Worker subflake with
contract-first APIs and local test coverage.

Phase 5 implementation includes:

- Hono-based router composition in `r2-explorer/src/app.ts`.
- Zod request/response schemas in `r2-explorer/src/schemas.ts` used across API
  handlers.
- Central middleware layering:
  - Access identity extraction
  - readonly enforcement (`R2E_READONLY=true`)
  - route-level auth (Access-only or Access/HMAC hybrid)
  - structured error responses
- Object operations:
  - list/meta/download/preview
  - multipart upload init/part/complete/abort
  - object move and soft-delete to `.trash/`
- Share lifecycle:
  - create/list/revoke on `/api/share/*`
  - public token download on `/share/<token>`
- KV-backed random share token records (`R2E_SHARES_KV`).
- Admin HMAC keyset + nonce replay tracking (`R2E_KEYS_KV`).
- Runtime capability endpoint: `GET /api/server/info`.
- Worker test suite (`vitest`) covering auth, share lifecycle, replay
  protection, readonly mode, multipart flow, and server info.

Current API surface:

| Route                       | Purpose                                          |
| --------------------------- | ------------------------------------------------ |
| `GET /api/list`             | List objects/prefixes                            |
| `GET /api/meta`             | Object metadata                                  |
| `GET /api/download`         | Download with attachment disposition             |
| `GET /api/preview`          | Inline/attachment preview by content type        |
| `POST /api/upload/init`     | Start multipart upload                           |
| `POST /api/upload/part`     | Upload multipart part                            |
| `POST /api/upload/complete` | Complete multipart upload                        |
| `POST /api/upload/abort`    | Abort multipart upload                           |
| `POST /api/object/delete`   | Soft-delete object to `.trash/`                  |
| `POST /api/object/move`     | Move/rename object                               |
| `POST /api/share/create`    | Create share token (Access or HMAC admin auth)   |
| `POST /api/share/revoke`    | Revoke share token (Access or HMAC admin auth)   |
| `GET /api/share/list`       | List share records for key (Access or HMAC auth) |
| `GET /api/server/info`      | Runtime capabilities and effective limits        |
| `GET /share/<token>`        | Public tokenized object access                   |

### CI/CD Deployment

Stage 5 keeps deployment automation lightweight and local-first. CI hardening
and managed deploy workflows remain in Phase 7.

## Authentication Setup

### Cloudflare Access (Zero Trust)

Configure in Cloudflare dashboard:

1. **Identity Providers** (Zero Trust → Settings → Authentication):
   - GitHub OAuth
   - Email OTP (One-time PIN)
   - Apple Login (if available)

2. **Access Application**:
   - Domain: `files.yourdomain.com`
   - Path policy split:
     - `/*` → **Allow** trusted identities (org/users)
     - `/share/*` → **Bypass** for public token links

### Sharing Modes and Constraints

#### Presigned URLs (S3 endpoint only)

Use the `r2 share` CLI for quick sharing. These links are always on the S3 endpoint
(`https://<account_id>.r2.cloudflarestorage.com`) and **do not** pass through the custom
domain or Cloudflare Access.

```bash
# Share file for 24 hours (default)
r2 share documents report.pdf

# Share for 7 days
r2 share documents report.pdf 168h
```

#### Worker Share Links (custom domain)

Use the Worker (R2-Explorer) to mint share tokens and proxy downloads on the custom
domain. Links are served under `https://files.yourdomain.com/share/<token>` and use
KV-backed random token records with expiry/revocation/download-limit checks.

`/api/*` routes require Cloudflare Access identity. CLI-driven Worker share
operations (`r2 share worker ...`) authenticate with admin HMAC headers
validated against `R2E_KEYS_KV`.

## Files (Current State)

| File                                  | Purpose                                                  |
| ------------------------------------- | -------------------------------------------------------- |
| `packages/r2-cli.nix`                 | Primary `r2` CLI with presigned + Worker share commands  |
| `r2-explorer/flake.nix`               | Worker subflake tooling/dev shell/deploy helper          |
| `r2-explorer/wrangler.toml`           | Worker bindings + runtime vars (`R2E_*`)                 |
| `r2-explorer/src/index.ts`            | Worker entrypoint                                        |
| `r2-explorer/src/app.ts`              | Hono router, middleware chain, handlers                  |
| `r2-explorer/src/schemas.ts`          | Zod contracts for query/body/response payloads           |
| `r2-explorer/src/auth.ts`             | Access and admin HMAC verification logic                 |
| `r2-explorer/src/kv.ts`               | Share record persistence and listing in KV               |
| `r2-explorer/src/r2.ts`               | R2 object helpers (list/get/move/soft-delete/multipart)  |
| `r2-explorer/src/ui.ts`               | Embedded dashboard interface                             |
| `r2-explorer/src/version.ts`          | Worker version constant exposed by `/api/server/info`    |
| `r2-explorer/tests/*.spec.ts`         | Worker tests (auth/share/readonly/multipart/server info) |
| `r2-explorer/tests/helpers/memory.ts` | In-memory R2+KV test harness                             |
| `docs/sharing.md`                     | Sharing modes + Access bypass policy guidance            |

## Verification

### After Repository Setup

```bash
# Build and check
nix flake check
nix build .#r2

# Test CLI tools
nix run .#r2 -- help
nix run .#r2 -- bucket help
nix run .#r2 -- share help
nix run .#r2 -- share worker help
nix run .#r2 -- rclone --help

# Run full local validation (formats + hooks + module eval + worker tests)
./scripts/ci/validate.sh

# Enter dev shell for manual work
nix develop
```

### After Consumer Integration

```bash
# On consumer system after nixos-rebuild
r2 bucket list
r2 bucket create test-bucket
r2 bucket lifecycle test-bucket 30
# Verify lifecycle (requires wrangler in PATH)
wrangler r2 bucket lifecycle get test-bucket
sudo systemctl status r2-mount-documents
ls /mnt/r2/documents

# Test sync
echo "test" > /mnt/r2/documents/test.txt
sudo systemctl start r2-bisync-documents
r2 rclone ls r2:documents/

# Test sharing
# Presigned (S3 endpoint only)
r2 share documents test.txt

# Worker share (custom domain)
export R2_EXPLORER_BASE_URL="https://files.yourdomain.com"
export R2_EXPLORER_ADMIN_KID="<active-kid>"
export R2_EXPLORER_ADMIN_SECRET="<matching-secret>"
r2 share worker create files documents/test.txt 24h --max-downloads 1
r2 share worker list files documents/test.txt
```

### R2-Explorer Deployment

```bash
cd r2-explorer
nix develop
wrangler login
pnpm install
pnpm run check
pnpm test
wrangler deploy

# Verify
curl -I https://files.yourdomain.com
# Should redirect to Cloudflare Access
curl -I https://files.yourdomain.com/share/<token>
# Should return object response when token is valid (public link path)

# Verify API remains Access-protected
curl -I https://files.yourdomain.com/api/list
# Should require Cloudflare Access session

# Verify runtime capability endpoint (with Access session)
curl -s https://files.yourdomain.com/api/server/info | jq .
```

## Implementation Order

1. [x] **Phase 1**: Repository scaffold + flake.nix
2. [x] **Phase 2**: NixOS modules (r2-sync.nix, r2-restic.nix)
3. [x] **Phase 3**: Home Manager modules (`r2` wrapper, credentials assembly, managed `rclone.conf`)
4. [x] **Phase 4**: CLI package extraction/refactor (single `r2` package CLI + HM wrapper delegation)
5. [x] **Phase 5**: R2-Explorer subflake (Hono+Zod contracts, middleware layering, `/api/server/info`, worker tests)
6. [ ] **Phase 6**: Templates and documentation (expanded matrix below)
7. [ ] **Phase 7**: CI/CD setup (expanded matrix below)

## Phase 6 Milestone Matrix (Templates + Documentation)

| Milestone                          | Scope / Tasks                                                                                                                                         | Deliverables                                                                                                               | Exit Criteria                                                                                                                       | Status |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **6.1 Template hardening**         | Finalize `templates/minimal` and `templates/full`; ensure both include valid pinned inputs and runnable examples for current module options.          | Updated template flakes and inline comments.                                                                               | `nix flake check` passes for template-generated repos; quickstart commands run without manual patching.                             | [x]    |
| **6.2 Option reference docs**      | Document NixOS + Home Manager options with defaults, required fields, and failure semantics.                                                          | `docs/` reference pages for `services.r2-sync`, `services.r2-restic`, `programs.r2-cloud`, credentials, and rclone config. | Every public option in modules has corresponding docs entry and example snippet.                                                    | [x]    |
| **6.3 Operator runbooks**          | Add operational procedures: key rotation, readonly maintenance windows, Access policy split, incident response, and rollback of Worker/share configs. | Runbook sections in `docs/sharing.md` and dedicated operator docs.                                                         | A new operator can execute setup/rotation/recovery using docs only.                                                                 | [x]    |
| **6.4 End-user workflows**         | Expand practical usage docs for sync, backup, annex, and worker share flows across local + remote contexts.                                           | Updated `docs/quickstart.md`, `docs/sync.md`, `docs/versioning.md`, and quickstart-linked sharing flow guidance.           | Template-specific local + remote workflows (including worker-share checkpoints) are complete and verified against current commands. | [ ]    |
| **6.5 Troubleshooting matrix**     | Add common failure signatures and root-cause/repair paths for auth, lifecycle, bisync, restic, multipart upload, and token validation.                | Troubleshooting section(s) with command-level diagnostics.                                                                 | Each critical subsystem has at least one known-failure diagnostic workflow.                                                         | [x]    |
| **6.6 Documentation quality gate** | Ensure docs stay synchronized with code changes via validation checks and explicit review checklist.                                                  | Updated validation guidance in docs and CI docs checks (Phase 7 wiring reference).                                         | No stale phase language remains; docs reviewed against current repository behavior.                                                 | [x]    |

### 6.4 Reopen Note (2026-02-07)

- `6.4` was reopened after audit due to mixed minimal/full verification commands in one path, ambiguous "after switch" wording, and missing worker-share checkpoint in end-user workflow sequencing.
- Closure requires template-specific verification paths and explicit local + remote expected outcomes.

## Phase 7 Milestone Matrix (CI/CD + Release)

| Milestone                               | Scope / Tasks                                                                                                          | Deliverables                                                                  | Exit Criteria                                                                             | Status |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------ |
| **7.1 CI matrix baseline**              | Build root CI jobs for format/lint/flake/module eval and Worker typecheck/tests.                                       | `.github/workflows/ci.yml` jobs for root + `r2-explorer` checks.              | PRs must pass full validation equivalent to `./scripts/ci/validate.sh`.                   | [ ]    |
| **7.2 Worker deploy pipeline**          | Implement deploy workflow for `r2-explorer` with environment scoping, required secrets, and protected branch controls. | `r2-explorer/.github/workflows/deploy.yml` production-ready workflow.         | Controlled deployment to Worker using CI credentials only; manual deploy still supported. | [ ]    |
| **7.3 Security and supply-chain gates** | Add dependency audit, secret scanning, and policy checks for changed files and lockfiles.                              | CI security jobs and documented remediation process.                          | Security gates fail on critical findings and block release merges.                        | [ ]    |
| **7.4 Release automation**              | Add semver/tag workflow, changelog generation, and release notes for root + worker updates.                            | Release workflow(s), versioning policy, and changelog process docs.           | Tagged release produces reproducible artifacts and clear upgrade notes.                   | [ ]    |
| **7.5 Deploy verification + rollback**  | Add post-deploy smoke checks and rollback playbook for Worker and CLI-impacting changes.                               | Post-deploy checks + rollback runbook + optional canary/manual approval step. | Failed smoke checks trigger rollback path with documented operator actions.               | [ ]    |
| **7.6 Branch protection enforcement**   | Wire required checks, review policy, and merge guards to prevent bypassing release quality bars.                       | Repository protection configuration documented and enabled.                   | Main branch requires green CI + review before merge/deploy.                               | [ ]    |
