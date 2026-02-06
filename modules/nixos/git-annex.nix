{ config, lib, ... }:
let
  cfg = config.programs.git-annex-r2;
in
{
  options.programs.git-annex-r2 = {
    enable = lib.mkEnableOption "git-annex R2 integration";

    credentialsFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Path to credentials env file";
    };
  };

  config = lib.mkIf cfg.enable {
    warnings = [ "programs.git-annex-r2 is a Phase 1 stub; implementation lands in Phase 2." ];
  };
}
