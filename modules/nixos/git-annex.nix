{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.git-annex-r2;
  credentialsFileValue = if cfg.credentialsFile == null then "" else toString cfg.credentialsFile;
  gitAnnexR2Init = pkgs.writeShellApplication {
    name = "git-annex-r2-init";
    runtimeInputs = [
      pkgs.bash
      pkgs.coreutils
      pkgs.git
      pkgs.git-annex
      pkgs.rclone
    ];
    text = ''
      set -euo pipefail

      credentials_file=${lib.escapeShellArg credentialsFileValue}
      rclone_remote_default=${lib.escapeShellArg cfg.rcloneRemoteName}
      default_bucket=${lib.escapeShellArg (if cfg.defaultBucket != null then cfg.defaultBucket else "")}
      default_prefix=${lib.escapeShellArg (if cfg.defaultPrefix != null then cfg.defaultPrefix else "")}

      if [[ ! -r "$credentials_file" ]]; then
        echo "Error: credentials file is missing or unreadable: $credentials_file" >&2
        exit 1
      fi

      set -a
      # shellcheck source=/dev/null
      source "$credentials_file"
      set +a

      if [[ -z "''${R2_ACCOUNT_ID:-}" ]]; then
        echo "Error: R2_ACCOUNT_ID is missing in credentials file: $credentials_file" >&2
        exit 1
      fi
      if [[ -z "''${AWS_ACCESS_KEY_ID:-}" ]]; then
        echo "Error: AWS_ACCESS_KEY_ID is missing in credentials file: $credentials_file" >&2
        exit 1
      fi
      if [[ -z "''${AWS_SECRET_ACCESS_KEY:-}" ]]; then
        echo "Error: AWS_SECRET_ACCESS_KEY is missing in credentials file: $credentials_file" >&2
        exit 1
      fi

      if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        echo "Error: git-annex-r2-init must be run inside a git repository." >&2
        exit 1
      fi

      remote_name="''${1:-$rclone_remote_default}"
      bucket="''${2:-$default_bucket}"
      if [[ -z "$bucket" ]]; then
        bucket="$(basename "$PWD")"
      fi
      prefix="''${3:-$default_prefix}"
      if [[ -z "$prefix" ]]; then
        prefix="annex/$bucket"
      fi

      if [[ -z "$remote_name" ]]; then
        echo "Error: remote name resolved to empty value." >&2
        exit 1
      fi

      if ! git config --get annex.uuid >/dev/null 2>&1; then
        git annex init "$(${pkgs.coreutils}/bin/uname -n)"
      fi

      if git annex info "$remote_name" >/dev/null 2>&1; then
        echo "Remote '$remote_name' already exists."
        exit 0
      fi

      git annex initremote "$remote_name" \
        type=rclone \
        rcloneremotename="$rclone_remote_default" \
        rcloneprefix="$prefix" \
        encryption=none

      echo "Initialized R2 special remote:"
      echo "  git-annex remote: $remote_name"
      echo "  rclone remote:    $rclone_remote_default"
      echo "  bucket hint:      $bucket"
      echo "  rclone prefix:    $prefix"
      echo
      echo "Next commands:"
      echo "  git annex add <large-files>"
      echo "  git annex sync --content"
      echo "  git annex drop <file>"
      echo "  git annex get <file>"
    '';
  };
in
{
  options.programs.git-annex-r2 = {
    enable = lib.mkEnableOption "git-annex R2 integration";

    credentialsFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Path to credentials env file used by git-annex/rclone (env_auth)";
      example = "/run/secrets/r2-credentials";
    };

    rcloneRemoteName = lib.mkOption {
      type = lib.types.str;
      default = "r2";
      description = "rclone remote name used by git-annex initremote type=rclone";
    };

    defaultBucket = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Default bucket hint used by git-annex-r2-init when bucket is omitted";
      example = "project-files";
    };

    defaultPrefix = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Default rcloneprefix used by git-annex-r2-init when prefix is omitted";
      example = "annex/project-files";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.credentialsFile != null;
        message = "programs.git-annex-r2.credentialsFile must be set when programs.git-annex-r2.enable = true";
      }
      {
        assertion = cfg.rcloneRemoteName != "";
        message = "programs.git-annex-r2.rcloneRemoteName must be a non-empty string when programs.git-annex-r2.enable = true";
      }
      {
        assertion = cfg.defaultBucket == null || cfg.defaultBucket != "";
        message = "programs.git-annex-r2.defaultBucket must be null or a non-empty string when programs.git-annex-r2.enable = true";
      }
      {
        assertion = cfg.defaultPrefix == null || cfg.defaultPrefix != "";
        message = "programs.git-annex-r2.defaultPrefix must be null or a non-empty string when programs.git-annex-r2.enable = true";
      }
    ];

    environment.systemPackages = [
      pkgs.git-annex
      pkgs.rclone
      gitAnnexR2Init
    ];
  };
}
