{ config, lib, ... }:
let
  cfg = config.services.r2-restic;
in
{
  options.services.r2-restic = {
    enable = lib.mkEnableOption "Restic backups to R2";

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

    passwordFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Path to restic password file";
    };

    bucket = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "R2 bucket for backups";
    };

    paths = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      default = [ ];
      description = "Paths to back up";
    };
  };

  config = lib.mkIf cfg.enable {
    warnings = [ "services.r2-restic is a Phase 1 stub; implementation lands in Phase 2." ];
  };
}
