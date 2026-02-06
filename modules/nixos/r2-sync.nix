{ config, lib, ... }:
let
  cfg = config.services.r2-sync;
in
{
  options.services.r2-sync = {
    enable = lib.mkEnableOption "R2 mount and bisync service";

    accountId = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Cloudflare account ID";
    };

    credentialsFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Path to credentials env file";
    };

    mounts = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = { };
      description = "Mount definitions (implemented in Phase 2)";
    };
  };

  config = lib.mkIf cfg.enable {
    warnings = [ "services.r2-sync is a Phase 1 stub; implementation lands in Phase 2." ];
  };
}
