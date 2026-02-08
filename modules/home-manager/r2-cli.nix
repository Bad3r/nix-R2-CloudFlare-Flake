{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.r2-cloud;
  r2lib = import ../../lib/r2.nix { inherit lib; };
  optionalPkg = name: if builtins.hasAttr name pkgs then [ pkgs.${name} ] else [ ];
  wranglerPkg =
    if builtins.hasAttr "nodePackages" pkgs && builtins.hasAttr "wrangler" pkgs.nodePackages then
      pkgs.nodePackages.wrangler
    else if builtins.hasAttr "wrangler" pkgs then
      pkgs.wrangler
    else
      null;
  r2Package = pkgs.callPackage ../../packages/r2-cli.nix { wrangler = wranglerPkg; };
  defaultCredentialsFile = "${config.xdg.configHome}/cloudflare/r2/env";
  defaultRcloneConfigPath = "${config.xdg.configHome}/rclone/rclone.conf";
  resolveAccountIdShell = r2lib.mkResolveAccountIdShell {
    literalAccountId = cfg.accountId;
    inherit (cfg) accountIdFile;
    envVar = "R2_ACCOUNT_ID";
    outputVar = "R2_RESOLVED_ACCOUNT_ID";
  };
  r2Wrapper = pkgs.writeShellApplication {
    name = "r2";
    text = ''
      set -euo pipefail
      export R2_CREDENTIALS_FILE=${lib.escapeShellArg (toString cfg.credentialsFile)}
      export R2_RCLONE_CONFIG=${lib.escapeShellArg (toString cfg.rcloneConfigPath)}

      if [[ -r "$R2_CREDENTIALS_FILE" ]]; then
        set -a
        # shellcheck source=/dev/null
        source "$R2_CREDENTIALS_FILE"
        set +a
      fi

      ${resolveAccountIdShell}
      export R2_DEFAULT_ACCOUNT_ID="$R2_RESOLVED_ACCOUNT_ID"

      enable_rclone_remote=${lib.boolToString cfg.enableRcloneRemote}
      literal_account_id=${lib.escapeShellArg cfg.accountId}
      if [[ "$enable_rclone_remote" == "true" && -z "$literal_account_id" ]]; then
        rclone_remote=${lib.escapeShellArg cfg.rcloneRemoteName}
        remote_env_name="$(printf '%s' "$rclone_remote" | ${pkgs.coreutils}/bin/tr '[:lower:]' '[:upper:]')"
        if [[ ! "$remote_env_name" =~ ^[A-Z0-9_]+$ ]]; then
          echo "Error: rclone remote name must be env-var-safe for endpoint export: $rclone_remote" >&2
          exit 1
        fi
        export "RCLONE_CONFIG_''${remote_env_name}_ENDPOINT=https://$R2_RESOLVED_ACCOUNT_ID.r2.cloudflarestorage.com"
      fi
      exec ${r2Package}/bin/r2 "$@"
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

    accountIdFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Path to file containing Cloudflare account ID";
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
        assertion = cfg.accountId != "" || cfg.accountIdFile != null;
        message = "programs.r2-cloud.accountId or programs.r2-cloud.accountIdFile must be set when programs.r2-cloud.enable = true";
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

    home.packages = [ r2Wrapper ] ++ lib.optionals cfg.installTools toolPackages;
  };
}
