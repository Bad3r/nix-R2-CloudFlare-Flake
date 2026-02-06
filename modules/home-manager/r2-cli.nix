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
  r2Package = pkgs.callPackage ../../packages/r2-cli.nix { wrangler = wranglerPkg; };
  defaultCredentialsFile = "${config.xdg.configHome}/cloudflare/r2/env";
  defaultRcloneConfigPath = "${config.xdg.configHome}/rclone/rclone.conf";
  wrapperEnv = ''
    export R2_CREDENTIALS_FILE=${lib.escapeShellArg (toString cfg.credentialsFile)}
    export R2_RCLONE_CONFIG=${lib.escapeShellArg (toString cfg.rcloneConfigPath)}
    export R2_DEFAULT_ACCOUNT_ID=${lib.escapeShellArg cfg.accountId}
  '';
  r2Wrapper = pkgs.writeShellApplication {
    name = "r2";
    text = ''
      set -euo pipefail
      ${wrapperEnv}
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

    home.packages = [ r2Wrapper ] ++ lib.optionals cfg.installTools toolPackages;
  };
}
