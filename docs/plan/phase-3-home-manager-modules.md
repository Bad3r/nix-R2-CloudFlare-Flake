# Phase 3: Home Manager modules

## Module specifications

### 5. Home Manager Module: r2-credentials.nix

```nix
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.r2-cloud.credentials;
  effectiveAccountId =
    if cfg.accountId != "" then cfg.accountId else
    if config.programs.r2-cloud.accountId != "" then config.programs.r2-cloud.accountId else
    if cfg.accountIdFile != null then builtins.readFile cfg.accountIdFile else
    if config.programs.r2-cloud.accountIdFile != null then builtins.readFile config.programs.r2-cloud.accountIdFile else
    "";
in
{
  options.programs.r2-cloud.credentials = {
    manage = lib.mkEnableOption "Manage R2 credentials env file";
    accountId = lib.mkOption { type = lib.types.str; default = ""; };
    accountIdFile = lib.mkOption { type = lib.types.nullOr lib.types.path; default = null; };
    accessKeyIdFile = lib.mkOption { type = lib.types.nullOr lib.types.path; default = null; };
    secretAccessKeyFile = lib.mkOption { type = lib.types.nullOr lib.types.path; default = null; };
    outputFile = lib.mkOption { type = lib.types.path; default = "${config.xdg.configHome}/cloudflare/r2/env"; };
  };

  config = lib.mkIf cfg.manage {
    assertions = [
      { assertion = effectiveAccountId != ""; message = "R2 account ID must be set for credential management (literal or file)"; }
      { assertion = cfg.accessKeyIdFile != null; message = "accessKeyIdFile is required when manage = true"; }
      { assertion = cfg.secretAccessKeyFile != null; message = "secretAccessKeyFile is required when manage = true"; }
    ];

    # Builds credentials file from secret file inputs (sops-nix/agenix/etc)
    home.activation.r2-cloud-credentials = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      set -euo pipefail
      # mkdir, write file, chmod 0400
      # R2_ACCOUNT_ID=...
      # AWS_ACCESS_KEY_ID=...
      # AWS_SECRET_ACCESS_KEY=...
    '';
  };
}
```

### 6. Home Manager Module: rclone-config.nix

```nix
{ config, lib, ... }:
let
  cfg = config.programs.r2-cloud;
in
{
  config = lib.mkIf (cfg.enable && cfg.enableRcloneRemote) {
    assertions = [
      # rcloneConfigPath must be under config.xdg.configHome
      # accountId must be non-empty
    ];

    xdg.configFile."rclone/rclone.conf".text = ''
      [${cfg.rcloneRemoteName}]
      type = s3
      provider = Cloudflare
      env_auth = true
      endpoint = https://${cfg.accountId}.r2.cloudflarestorage.com
    '';
  };
}
```
