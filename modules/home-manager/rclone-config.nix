{ config, lib, ... }:
let
  cfg = lib.attrByPath [
    "programs"
    "r2-cloud"
  ] null config;
  enableRcloneConfig = cfg != null && (cfg.enable or false) && (cfg.enableRcloneRemote or false);
in
{
  config = lib.mkIf enableRcloneConfig {
    warnings = [ "rclone remote generation is a Phase 1 stub; implementation lands in Phase 3." ];
  };
}
