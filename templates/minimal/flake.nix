{
  description = "Minimal Cloudflare R2 template (sync only)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Replace with your fork if needed.
    r2-cloud.url = "github:Bad3r/nix-R2-CloudFlare-Flake?ref=main";
  };

  outputs =
    {
      nixpkgs,
      r2-cloud,
      ...
    }:
    let
      system = "x86_64-linux";
    in
    {
      nixosConfigurations.r2-minimal = nixpkgs.lib.nixosSystem {
        inherit system;
        modules = [
          r2-cloud.nixosModules.default
          {
            system.stateVersion = "25.05";
            # Eval-only defaults so `nix flake check` passes in generated repos.
            fileSystems."/" = {
              device = "tmpfs";
              fsType = "tmpfs";
            };
            boot.loader.grub.devices = [ "nodev" ];

            # Required for services.r2-sync.
            programs.fuse.userAllowOther = true;
            services.r2-sync = {
              enable = true;
              accountIdFile = "/run/secrets/r2/account-id";
              credentialsFile = "/run/secrets/r2/credentials.env";
              mounts.documents = {
                bucket = "documents";
                remotePrefix = "documents";
                mountPoint = "/data/r2/mount/documents";
                localPath = "/data/r2/documents";
                syncInterval = "10m";
              };
            };
          }
        ];
      };
    };
}
