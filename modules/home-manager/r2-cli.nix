{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.r2-cloud;
  optionalPkg = name: if builtins.hasAttr name pkgs then [ pkgs.${name} ] else [ ];
  wranglerPkg =
    if builtins.hasAttr "nodePackages" pkgs && builtins.hasAttr "wrangler" pkgs.nodePackages then
      pkgs.nodePackages.wrangler
    else if builtins.hasAttr "wrangler" pkgs then
      pkgs.wrangler
    else
      null;
  defaultCredentialsFile = "${config.xdg.configHome}/cloudflare/r2/env";
  defaultRcloneConfigPath = "${config.xdg.configHome}/rclone/rclone.conf";
  sharedScriptSetup = ''
    set -euo pipefail

    credentials_file=${lib.escapeShellArg (toString cfg.credentialsFile)}
    default_account_id=${lib.escapeShellArg cfg.accountId}

    if [[ ! -r "$credentials_file" ]]; then
      echo "Error: credentials file is missing or unreadable: $credentials_file" >&2
      exit 1
    fi

    set -a
    # shellcheck source=/dev/null
    source "$credentials_file"
    set +a

    account_id="''${R2_ACCOUNT_ID:-$default_account_id}"
    if [[ -z "$account_id" ]]; then
      echo "Error: R2 account ID is missing. Set R2_ACCOUNT_ID or programs.r2-cloud.accountId." >&2
      exit 1
    fi

    export R2_ACCOUNT_ID="$account_id"
    export CLOUDFLARE_ACCOUNT_ID="$account_id"
  '';
  r2Wrapper = pkgs.writeShellApplication {
    name = "r2";
    runtimeInputs = [ pkgs.rclone ];
    text = ''
      ${sharedScriptSetup}

      rclone_config_path=${lib.escapeShellArg (toString cfg.rcloneConfigPath)}
      exec ${pkgs.rclone}/bin/rclone --config "$rclone_config_path" "$@"
    '';
  };
  r2BucketWrapper = pkgs.writeShellApplication {
    name = "r2-bucket";
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
            ${sharedScriptSetup}

            wrangler_bin=${
              lib.escapeShellArg (if wranglerPkg != null then "${wranglerPkg}/bin/wrangler" else "")
            }
            if [[ -z "$wrangler_bin" || ! -x "$wrangler_bin" ]]; then
              echo "Error: wrangler is not available. Install wrangler or set programs.r2-cloud.installTools = true." >&2
              exit 1
            fi

            cmd="''${1:-help}"
            shift || true

            case "$cmd" in
              create)
                name="''${1:?Bucket name required}"
                "$wrangler_bin" r2 bucket create "$name"
                echo "Created bucket: $name"
                ;;
              list)
                "$wrangler_bin" r2 bucket list
                ;;
              delete)
                name="''${1:?Bucket name required}"
                read -r -p "Delete bucket '$name'? [y/N] " confirm
                if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
                  echo "Cancelled"
                  exit 0
                fi
                "$wrangler_bin" r2 bucket delete "$name"
                echo "Deleted bucket: $name"
                ;;
              lifecycle)
                name="''${1:?Bucket name required}"
                days="''${2:-30}"
                if [[ ! "$days" =~ ^[0-9]+$ ]]; then
                  echo "Error: retention days must be a non-negative integer (got '$days')." >&2
                  exit 1
                fi

                rules_file="$(mktemp)"
                trap 'rm -f "$rules_file"' EXIT
                cat > "$rules_file" <<JSON
      {"rules":[{"id":"trash-cleanup","prefix":".trash/","expiration":{"days":$days}}]}
      JSON
                "$wrangler_bin" r2 bucket lifecycle set "$name" --file "$rules_file"
                rm -f "$rules_file"
                trap - EXIT
                echo "Set .trash/ retention to $days days for bucket: $name"
                ;;
              help|-h|--help)
                cat <<'USAGE'
      Usage: r2-bucket <command> [args]

      Commands:
        create <name>         Create a new bucket
        list                  List all buckets
        delete <name>         Delete a bucket
        lifecycle <name> [d]  Set .trash/ retention in days (default: 30)
      USAGE
                ;;
              *)
                echo "Error: unknown command '$cmd'" >&2
                exit 1
                ;;
            esac
    '';
  };
  r2ShareWrapper = pkgs.writeShellApplication {
    name = "r2-share";
    runtimeInputs = [ pkgs.rclone ];
    text = ''
      ${sharedScriptSetup}

      if [[ -z "''${AWS_ACCESS_KEY_ID:-}" ]]; then
        echo "Error: AWS_ACCESS_KEY_ID is missing in credentials file: $credentials_file" >&2
        exit 1
      fi
      if [[ -z "''${AWS_SECRET_ACCESS_KEY:-}" ]]; then
        echo "Error: AWS_SECRET_ACCESS_KEY is missing in credentials file: $credentials_file" >&2
        exit 1
      fi

      bucket="''${1:?Usage: r2-share <bucket> <key> [expiry]}"
      key="''${2:?Usage: r2-share <bucket> <key> [expiry]}"
      expiry="''${3:-24h}"

      exec ${pkgs.rclone}/bin/rclone link \
        --config=/dev/null \
        --s3-provider=Cloudflare \
        --s3-endpoint="https://$account_id.r2.cloudflarestorage.com" \
        --s3-access-key-id="$AWS_ACCESS_KEY_ID" \
        --s3-secret-access-key="$AWS_SECRET_ACCESS_KEY" \
        --expire="$expiry" \
        ":s3:$bucket/$key"
    '';
  };
  toolPackages = [
    pkgs.rclone
    pkgs.restic
  ]
  ++ optionalPkg "git-annex"
  ++ lib.optional (wranglerPkg != null) wranglerPkg;
in
{
  options.programs.r2-cloud = {
    enable = lib.mkEnableOption "R2 cloud CLI helpers";

    accountId = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Cloudflare account ID";
    };

    credentialsFile = lib.mkOption {
      type = lib.types.path;
      default = defaultCredentialsFile;
      description = "Path to credentials env file";
    };

    enableRcloneRemote = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to configure a Cloudflare R2 remote in rclone";
    };

    rcloneRemoteName = lib.mkOption {
      type = lib.types.str;
      default = "r2";
      description = "Name of the generated rclone remote";
    };

    rcloneConfigPath = lib.mkOption {
      type = lib.types.path;
      default = defaultRcloneConfigPath;
      description = "Path to the generated rclone config file";
    };

    installTools = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Install runtime dependencies (rclone, restic, git-annex, wrangler when available)";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.accountId != "";
        message = "programs.r2-cloud.accountId must be set when programs.r2-cloud.enable = true";
      }
      {
        assertion = toString cfg.credentialsFile != "";
        message = "programs.r2-cloud.credentialsFile must be set when programs.r2-cloud.enable = true";
      }
      {
        assertion = (!cfg.enableRcloneRemote) || (cfg.rcloneRemoteName != "");
        message = "programs.r2-cloud.rcloneRemoteName must be a non-empty string when programs.r2-cloud.enableRcloneRemote = true";
      }
    ];

    home.packages = [
      r2Wrapper
      r2BucketWrapper
      r2ShareWrapper
    ]
    ++ lib.optionals cfg.installTools toolPackages;
  };
}
