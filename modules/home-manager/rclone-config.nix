{ config, lib, ... }:
let
  r2lib = import ../../lib/r2.nix { inherit lib; };
  cfg = lib.attrByPath [
    "programs"
    "r2-cloud"
  ] null config;
  enableRcloneConfig = cfg != null && (cfg.enable or false) && (cfg.enableRcloneRemote or false);
  xdgConfigHome = toString config.xdg.configHome;
  rcloneConfigPath =
    if cfg != null && cfg ? rcloneConfigPath then
      toString cfg.rcloneConfigPath
    else
      "${xdgConfigHome}/rclone/rclone.conf";
  rcloneConfigPrefix = "${xdgConfigHome}/";
  rcloneConfigUnderXdg = lib.hasPrefix rcloneConfigPrefix rcloneConfigPath;
  rcloneConfigRelative = lib.removePrefix rcloneConfigPrefix rcloneConfigPath;
  remoteName = if cfg != null && cfg ? rcloneRemoteName then cfg.rcloneRemoteName else "r2";
  accountId = if cfg != null && cfg ? accountId then cfg.accountId else "";
  hasAccountId = accountId != "";
  # Upstream home-manager's programs.rclone hardcodes this same path (not an
  # option), so a literal comparison is the only way to detect the collision.
  hmRcloneConfigPath = "${xdgConfigHome}/rclone/rclone.conf";
  hmRcloneEnabled = config.programs.rclone.enable or false;
in
{
  config = lib.mkIf enableRcloneConfig {
    assertions = [
      {
        assertion = rcloneConfigUnderXdg;
        message = "programs.r2-cloud.rcloneConfigPath must be within config.xdg.configHome when programs.r2-cloud.enableRcloneRemote = true";
      }
      {
        assertion = rcloneConfigRelative != "";
        message = "programs.r2-cloud.rcloneConfigPath must not equal config.xdg.configHome when programs.r2-cloud.enableRcloneRemote = true";
      }
      {
        assertion = remoteName != "";
        message = "programs.r2-cloud.rcloneRemoteName must be a non-empty string when programs.r2-cloud.enableRcloneRemote = true";
      }
      {
        assertion = !hmRcloneEnabled || rcloneConfigPath != hmRcloneConfigPath;
        message = "programs.r2-cloud.enableRcloneRemote and programs.rclone.enable must not both manage the same rclone.conf; disable programs.r2-cloud.enableRcloneRemote and declare the R2 remote under programs.rclone.remotes, or disable programs.rclone";
      }
    ];

    xdg.configFile."${rcloneConfigRelative}".text = ''
      [${remoteName}]
      type = s3
      provider = Cloudflare
      env_auth = true
      no_check_bucket = true
      ${lib.optionalString hasAccountId "endpoint = ${r2lib.mkR2Endpoint accountId}"}
    '';
  };
}
