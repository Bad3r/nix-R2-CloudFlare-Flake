{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.r2-cloud;
  optionalPkg = name: if builtins.hasAttr name pkgs then [ pkgs.${name} ] else [ ];
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
      default = "${config.xdg.configHome}/cloudflare/r2/env";
      description = "Path to credentials env file";
    };

    enableRcloneRemote = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to configure rclone remote in a later phase";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [
      pkgs.rclone
      pkgs.restic
      (pkgs.writers.writeBashBin "r2" ''
        echo "r2 alias wrapper is not implemented yet (Phase 3)." >&2
        exit 2
      '')
    ]
    ++ optionalPkg "git-annex";

    warnings = [ "programs.r2-cloud is a Phase 1 stub; implementation lands in Phase 3." ];
  };
}
