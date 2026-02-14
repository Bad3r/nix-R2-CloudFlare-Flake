{
  description = "Full Cloudflare R2 template (sync + backup + CLI + git-annex)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
    # Replace with your fork if needed.
    r2-cloud.url = "github:Bad3r/nix-R2-CloudFlare-Flake?ref=main";
  };

  outputs =
    {
      nixpkgs,
      home-manager,
      r2-cloud,
      ...
    }:
    let
      system = "x86_64-linux";
      username = "alice";
    in
    {
      nixosConfigurations.r2-full = nixpkgs.lib.nixosSystem {
        inherit system;
        modules = [
          r2-cloud.nixosModules.default
          home-manager.nixosModules.home-manager
          {
            system.stateVersion = "25.05";
            # Eval-only defaults so `nix flake check` passes in generated repos.
            fileSystems."/" = {
              device = "tmpfs";
              fsType = "tmpfs";
            };
            boot.loader.grub.devices = [ "nodev" ];
            users.users.${username} = {
              isNormalUser = true;
              group = username;
            };
            users.groups.${username} = { };

            programs.fuse.userAllowOther = true;
            services.r2-sync = {
              enable = true;
              accountIdFile = "/run/secrets/r2/account-id";
              credentialsFile = "/run/secrets/r2/credentials.env";
              mounts.workspace = {
                bucket = "files";
                remotePrefix = "workspace";
                mountPoint = "/data/r2/mount/workspace";
                localPath = "/data/r2/workspace";
                syncInterval = "5m";
              };
            };

            services.r2-restic = {
              enable = true;
              accountIdFile = "/run/secrets/r2/account-id";
              credentialsFile = "/run/secrets/r2/credentials.env";
              passwordFile = "/run/secrets/r2/restic-password";
              bucket = "backups";
              paths = [
                "/data/r2/workspace"
              ];
              schedule = "daily";
            };

            programs.git-annex-r2 = {
              enable = true;
              credentialsFile = "/run/secrets/r2/credentials.env";
              rcloneRemoteName = "r2";
              defaultBucket = "files";
              defaultPrefix = "annex/workspace";
            };

            home-manager = {
              useGlobalPkgs = true;
              useUserPackages = true;
              sharedModules = [ r2-cloud.homeManagerModules.default ];
              users.${username} = {
                home.stateVersion = "25.05";
                programs.r2-cloud = {
                  enable = true;
                  accountIdFile = "/run/secrets/r2/account-id";
                  credentialsFile = "/run/secrets/r2/credentials.env";
                  rcloneRemoteName = "r2";
                  installTools = true;
                };
              };
            };
          }
        ];
      };

      # Standalone Home Manager output for non-NixOS hosts.
      homeConfigurations.${username} = home-manager.lib.homeManagerConfiguration {
        pkgs = nixpkgs.legacyPackages.${system};
        modules = [
          r2-cloud.homeManagerModules.default
          {
            home = {
              inherit username;
              homeDirectory = "/home/${username}";
              stateVersion = "25.05";
            };
            programs.r2-cloud = {
              enable = true;
              accountIdFile = "/run/secrets/r2/account-id";
              credentialsFile = "/run/secrets/r2/credentials.env";
            };
          }
        ];
      };
    };
}
