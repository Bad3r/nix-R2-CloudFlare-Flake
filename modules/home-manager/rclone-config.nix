{ config, lib, ... }:
let
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
    ];

    xdg.configFile."${rcloneConfigRelative}".text = ''
      [${remoteName}]
      type = s3
      provider = Cloudflare
      env_auth = true
      ${lib.optionalString hasAccountId "endpoint = https://${accountId}.r2.cloudflarestorage.com"}
    '';
  };
}
