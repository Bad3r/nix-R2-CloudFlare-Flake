{ config, lib, ... }:
let
  cfg = config.programs.r2-cloud.credentials;
in
{
  options.programs.r2-cloud.credentials = {
    manage = lib.mkEnableOption "R2 credential file management";

    accountId = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Cloudflare account ID";
    };

    accessKeyIdFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Path to file containing AWS access key ID";
    };

    secretAccessKeyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Path to file containing AWS secret access key";
    };
  };

  config = lib.mkIf cfg.manage {
    warnings = [ "programs.r2-cloud.credentials is a Phase 1 stub; implementation lands in Phase 3." ];
  };
}
