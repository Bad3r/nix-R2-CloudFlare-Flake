{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.r2-cloud;
  r2lib = import ../../lib/r2.nix { inherit lib; };
  versionlib = import ../../lib/version.nix { inherit lib; };
  inherit (versionlib) releaseBase;
  r2DerivationVersion = versionlib.mkDerivationVersion {
    inherit releaseBase;
    src = ../../.;
  };
  defaultR2Package = pkgs.callPackage ../../packages/r2-cli.nix {
    inherit (pkgs) wrangler;
    derivationVersion = r2DerivationVersion;
    inherit releaseBase;
  };
  defaultCredentialsFile = "${config.xdg.configHome}/cloudflare/r2/env";
  defaultRcloneConfigPath = "${config.xdg.configHome}/rclone/rclone.conf";
  explorerEnvFileValue = if cfg.explorerEnvFile == null then "" else toString cfg.explorerEnvFile;
  resolveAccountIdShell = r2lib.mkResolveAccountIdShell {
    literalAccountId = cfg.accountId;
    inherit (cfg) accountIdFile;
    envVar = "R2_ACCOUNT_ID";
    outputVar = "R2_RESOLVED_ACCOUNT_ID";
  };
  r2Wrapper = pkgs.writeShellApplication {
    name = "r2";
    derivationArgs.name = "r2-wrapper-${r2DerivationVersion}";
    passthru.version = r2DerivationVersion;
    text = ''
      set -euo pipefail

      # help/version and a bare invocation must reach the inner CLI without
      # resolving an account ID or reading any file: a missing or broken
      # secret must not block `r2 help`.
      first_arg="''${1:-}"
      if [[ "$#" -eq 0 || "$first_arg" =~ ^(help|-h|--help|version|--version)$ ]]; then
        exec ${cfg.package}/bin/r2 "$@"
      fi

      ${r2lib.sourceEnvFileShellFunction}

      export R2_CREDENTIALS_FILE=${lib.escapeShellArg (toString cfg.credentialsFile)}
      export R2_RCLONE_CONFIG=${lib.escapeShellArg (toString cfg.rcloneConfigPath)}

      if [[ -r "$R2_CREDENTIALS_FILE" ]]; then
        r2_source_env_file "$R2_CREDENTIALS_FILE"
      fi

      explorer_env_file=${lib.escapeShellArg explorerEnvFileValue}
      if [[ -n "$explorer_env_file" && -r "$explorer_env_file" ]]; then
        r2_source_env_file "$explorer_env_file"
      fi

      ${resolveAccountIdShell}
      export R2_DEFAULT_ACCOUNT_ID="$R2_RESOLVED_ACCOUNT_ID"

      enable_rclone_remote=${lib.boolToString cfg.enableRcloneRemote}
      literal_account_id=${lib.escapeShellArg cfg.accountId}
      if [[ "$enable_rclone_remote" == "true" && -z "$literal_account_id" ]]; then
        rclone_remote=${lib.escapeShellArg cfg.rcloneRemoteName}
        remote_env_name="$(printf '%s' "$rclone_remote" | ${pkgs.coreutils}/bin/tr '[:lower:]' '[:upper:]')"
        if [[ ! "$remote_env_name" =~ ^[A-Z0-9_]+$ ]]; then
          echo "Error: rclone remote name must be env-var-safe for endpoint export: $rclone_remote" >&2
          exit 1
        fi
        export "RCLONE_CONFIG_''${remote_env_name}_ENDPOINT=${r2lib.mkR2Endpoint "\${R2_RESOLVED_ACCOUNT_ID}"}"
      fi
      exec ${cfg.package}/bin/r2 "$@"
    '';
  };
  toolPackages = [
    pkgs.rclone
    pkgs.restic
    pkgs.wrangler
  ]
  # git-annex is not packaged for every supported platform.
  ++ lib.optionals (pkgs ? git-annex) [ pkgs.git-annex ];
in
{
  options.programs.r2-cloud = {
    enable = lib.mkEnableOption "R2 cloud CLI helpers";

    package = lib.mkOption {
      type = lib.types.package;
      default = defaultR2Package;
      defaultText = lib.literalExpression "pkgs.callPackage ../../packages/r2-cli.nix { inherit (pkgs) wrangler; }";
      description = ''
        The `r2` CLI package wrapped by this module. Defaults to the CLI built
        from this flake's `packages/r2-cli.nix` using `pkgs.wrangler`. Set it
        to the flake's `packages.<system>.r2` output to reuse the exact CLI
        provided by `nix run .#r2`.
      '';
    };

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

    credentialsFile = lib.mkOption {
      type = lib.types.path;
      default = defaultCredentialsFile;
      description = "Path to credentials env file";
    };

    enableRcloneRemote = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to configure a Cloudflare R2 remote in rclone";
    };

    rcloneRemoteName = lib.mkOption {
      type = lib.types.str;
      default = "r2";
      description = "Name of the generated rclone remote";
    };

    rcloneConfigPath = lib.mkOption {
      type = lib.types.path;
      default = defaultRcloneConfigPath;
      description = "Path to the generated rclone config file";
    };

    explorerEnvFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Optional env file to source at runtime (after `credentialsFile`) for Worker
        share commands.

        Intended for `R2_EXPLORER_BASE_URL`,
        `R2_EXPLORER_ACCESS_CLIENT_ID`, and
        `R2_EXPLORER_ACCESS_CLIENT_SECRET`. Use a runtime path (for example
        `/run/secrets/r2/explorer.env`) to avoid embedding secrets in the Nix store.
      '';
      example = "/run/secrets/r2/explorer.env";
    };

    installTools = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Install runtime dependencies (rclone, restic, wrangler, and git-annex when available)";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.accountId != "" || cfg.accountIdFile != null;
        message = "programs.r2-cloud.accountId or programs.r2-cloud.accountIdFile must be set when programs.r2-cloud.enable = true";
      }
      {
        assertion = (!cfg.enableRcloneRemote) || (cfg.rcloneRemoteName != "");
        message = "programs.r2-cloud.rcloneRemoteName must be a non-empty string when programs.r2-cloud.enableRcloneRemote = true";
      }
      {
        # Endpoint-less mode exports RCLONE_CONFIG_<REMOTE>_ENDPOINT, and rclone's
        # fs.ConfigToEnv only uppercases the name, so it must be a shell identifier.
        assertion =
          (!cfg.enableRcloneRemote)
          || (cfg.accountId != "")
          || (builtins.match "[A-Za-z0-9_]+" cfg.rcloneRemoteName != null);
        message = "programs.r2-cloud.rcloneRemoteName must be env-var-safe ([A-Za-z0-9_]+) when programs.r2-cloud.enableRcloneRemote = true and programs.r2-cloud.accountId is empty, because it is exported as RCLONE_CONFIG_<REMOTE>_ENDPOINT";
      }
    ];

    home.packages = [ r2Wrapper ] ++ lib.optionals cfg.installTools toolPackages;
  };
}
