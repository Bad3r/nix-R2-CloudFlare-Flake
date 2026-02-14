{ metaOwner, ... }:
{
  configurations.nixos.system76.module =
    { config, lib, ... }:
    let
      inherit (metaOwner) username;
      group = lib.attrByPath [ "users" "users" username "group" ] "users" config;
      runAsUserServiceConfig = {
        User = username;
        Group = group;
      };
    in
    {
      # Allow non-root rclone mounts to use --allow-other.
      programs.fuse.userAllowOther = true;

      services.r2-sync = {
        enable = true;
        credentialsFile = "/run/secrets/r2/credentials.env";
        accountIdFile = "/run/secrets/r2/account-id";

        mounts.workspace = {
          bucket = "nix-r2-cf-r2e-files-prod";
          remotePrefix = "workspace";
          mountPoint = "/data/r2/mount/workspace";
          localPath = "/data/r2/workspace";
          syncInterval = "5m";
        };
      };

      services.r2-restic = {
        enable = true;
        credentialsFile = "/run/secrets/r2/credentials.env";
        accountIdFile = "/run/secrets/r2/account-id";
        passwordFile = "/run/secrets/r2/restic-password";
        bucket = "nix-r2-cf-backups-prod";
        paths = [ "/data/r2/workspace" ];
      };

      programs.git-annex-r2 = {
        enable = true;
        credentialsFile = "/run/secrets/r2/credentials.env";
      };

      # Provide `r2` + managed rclone remote in user PATH.
      home-manager.users.${username}.programs.r2-cloud = {
        enable = true;
        accountIdFile = "/run/secrets/r2/account-id";
        credentialsFile = "/run/secrets/r2/credentials.env";
      };

      # Run operational services as the real user so local workspace paths are
      # owned/editable by `vx`, not root.
      systemd = {
        services = {
          "r2-mount-workspace".serviceConfig = runAsUserServiceConfig;
          "r2-bisync-workspace".serviceConfig = runAsUserServiceConfig;
          "r2-restic-backup".serviceConfig = runAsUserServiceConfig;
        };

        # Ensure mount and local paths exist and are user-owned before services start.
        tmpfiles.rules = [
          "d /data/r2 0750 ${username} ${group} - -"
          "d /data/r2/mount 0750 ${username} ${group} - -"
          "d /data/r2/mount/workspace 0750 ${username} ${group} - -"
          "d /data/r2/workspace 0750 ${username} ${group} - -"
        ];
      };
    };
}
