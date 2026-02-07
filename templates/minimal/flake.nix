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

            # Required for services.r2-sync.
            services.r2-sync = {
              enable = true;
              accountId = "replace-with-cloudflare-account-id";
              credentialsFile = "/run/secrets/r2-credentials";
              mounts.documents = {
                bucket = "documents";
                mountPoint = "/mnt/r2/documents";
                localPath = "/var/lib/r2-sync/documents";
                syncInterval = "10m";
              };
            };
          }
        ];
      };
    };
}
