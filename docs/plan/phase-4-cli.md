# Phase 4: CLI packaging and wrappers

## Module specification

### 4. Home Manager Module: r2-cli.nix

```nix
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.r2-cloud;
in
{
  options.programs.r2-cloud = {
    enable = lib.mkEnableOption "R2 cloud CLI helpers";

    accountId = lib.mkOption { type = lib.types.str; default = ""; };
    accountIdFile = lib.mkOption { type = lib.types.nullOr lib.types.path; default = null; };
    credentialsFile = lib.mkOption { type = lib.types.path; default = "${config.xdg.configHome}/cloudflare/r2/env"; };
    enableRcloneRemote = lib.mkOption { type = lib.types.bool; default = true; };
    rcloneRemoteName = lib.mkOption { type = lib.types.str; default = "r2"; };
    rcloneConfigPath = lib.mkOption { type = lib.types.path; default = "${config.xdg.configHome}/rclone/rclone.conf"; };
    installTools = lib.mkOption { type = lib.types.bool; default = true; };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      { assertion = cfg.accountId != "" || cfg.accountIdFile != null; message = "programs.r2-cloud.accountId or accountIdFile must be set when programs.r2-cloud.enable = true"; }
      { assertion = cfg.rcloneRemoteName != "" || !cfg.enableRcloneRemote; message = "programs.r2-cloud.rcloneRemoteName must be non-empty when remote generation is enabled"; }
    ];

    # Installs wrapped CLI from package derivation:
    # - r2 (primary package-backed subcommand CLI)
    #
    # HM wrappers only inject default env/config and delegate to package binaries.
    home.packages = [ r2Wrapper ];
  };
}
```

Phase 4 extracts operational CLI logic into `packages/` derivations so it can be used directly via
`nix run` and reused by Home Manager wrappers. The HM module remains declarative and enforces
strict validation while injecting configuration defaults (`R2_CREDENTIALS_FILE`, `R2_RCLONE_CONFIG`,
`R2_DEFAULT_ACCOUNT_ID`).
