{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.r2-cloud.credentials;
  topCfg = lib.attrByPath [
    "programs"
    "r2-cloud"
  ] { } config;
  topEnable = topCfg ? enable && topCfg.enable;
  topCredentialsFile = if topCfg ? credentialsFile then toString topCfg.credentialsFile else null;
  topAccountId = topCfg.accountId or "";
  topAccountIdFile = topCfg.accountIdFile or null;
  hasAccountId =
    cfg.accountId != "" || topAccountId != "" || cfg.accountIdFile != null || topAccountIdFile != null;
  outputFile = toString cfg.outputFile;
  outputDir = builtins.dirOf outputFile;
  accountIdFile = if cfg.accountIdFile == null then "" else toString cfg.accountIdFile;
  topAccountIdFileValue = if topAccountIdFile == null then "" else toString topAccountIdFile;
  accessKeyIdFile = if cfg.accessKeyIdFile == null then "" else toString cfg.accessKeyIdFile;
  secretAccessKeyFile =
    if cfg.secretAccessKeyFile == null then "" else toString cfg.secretAccessKeyFile;
in
{
  options.programs.r2-cloud.credentials = {
    manage = lib.mkEnableOption "R2 credential file management";

    accountId = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Cloudflare account ID";
    };

    accountIdFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Path to file containing Cloudflare account ID";
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

    outputFile = lib.mkOption {
      type = lib.types.path;
      default = "${config.xdg.configHome}/cloudflare/r2/env";
      description = "Output path for generated credentials env file";
    };
  };

  config = lib.mkIf cfg.manage {
    assertions = [
      {
        assertion = hasAccountId;
        message = "programs.r2-cloud.credentials.accountId or accountIdFile (or programs.r2-cloud.accountId/accountIdFile) must be set when programs.r2-cloud.credentials.manage = true";
      }
      {
        assertion = cfg.accessKeyIdFile != null;
        message = "programs.r2-cloud.credentials.accessKeyIdFile must be set when programs.r2-cloud.credentials.manage = true";
      }
      {
        assertion = cfg.secretAccessKeyFile != null;
        message = "programs.r2-cloud.credentials.secretAccessKeyFile must be set when programs.r2-cloud.credentials.manage = true";
      }
      {
        assertion = !topEnable || topCredentialsFile == outputFile;
        message = "programs.r2-cloud.credentials.outputFile must match programs.r2-cloud.credentialsFile when both credential management and programs.r2-cloud.enable are enabled";
      }
    ];

    home.activation.r2-cloud-credentials = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      set -euo pipefail

      output_file=${lib.escapeShellArg outputFile}
      output_dir=${lib.escapeShellArg outputDir}
      account_id_literal=${lib.escapeShellArg cfg.accountId}
      account_id_file=${lib.escapeShellArg accountIdFile}
      top_account_id_literal=${lib.escapeShellArg topAccountId}
      top_account_id_file=${lib.escapeShellArg topAccountIdFileValue}
      access_key_id_file=${lib.escapeShellArg accessKeyIdFile}
      secret_access_key_file=${lib.escapeShellArg secretAccessKeyFile}

      if [[ ! -r "$access_key_id_file" ]]; then
        echo "Error: access key file is missing or unreadable: $access_key_id_file" >&2
        exit 1
      fi
      if [[ ! -r "$secret_access_key_file" ]]; then
        echo "Error: secret key file is missing or unreadable: $secret_access_key_file" >&2
        exit 1
      fi

      account_id=""
      if [[ -n "$account_id_literal" ]]; then
        account_id="$account_id_literal"
      elif [[ -n "$top_account_id_literal" ]]; then
        account_id="$top_account_id_literal"
      elif [[ -n "$account_id_file" && -r "$account_id_file" ]]; then
        { IFS= read -r account_id || true; } < "$account_id_file"
      elif [[ -n "$top_account_id_file" && -r "$top_account_id_file" ]]; then
        { IFS= read -r account_id || true; } < "$top_account_id_file"
      fi

      if [[ -z "$account_id" ]]; then
        echo "Error: account ID could not be resolved from literal or file inputs." >&2
        exit 1
      fi

      access_key_id="$(${pkgs.coreutils}/bin/cat "$access_key_id_file")"
      secret_access_key="$(${pkgs.coreutils}/bin/cat "$secret_access_key_file")"

      if [[ -z "$access_key_id" ]]; then
        echo "Error: access key file is empty: $access_key_id_file" >&2
        exit 1
      fi
      if [[ -z "$secret_access_key" ]]; then
        echo "Error: secret key file is empty: $secret_access_key_file" >&2
        exit 1
      fi

      ${pkgs.coreutils}/bin/mkdir -p "$output_dir"
      umask 077
      {
        printf 'R2_ACCOUNT_ID=%s\n' "$account_id"
        printf 'AWS_ACCESS_KEY_ID=%s\n' "$access_key_id"
        printf 'AWS_SECRET_ACCESS_KEY=%s\n' "$secret_access_key"
      } > "$output_file"
      ${pkgs.coreutils}/bin/chmod 0400 "$output_file"
    '';
  };
}
