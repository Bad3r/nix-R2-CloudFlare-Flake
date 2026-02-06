{
  description = "Minimal R2 cloud scaffold consumer";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    r2-cloud.url = "github:username/r2-cloud-nix";
  };

  outputs =
    {
      self,
      nixpkgs,
      r2-cloud,
      ...
    }:
    {
      nixosConfigurations.example = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        modules = [
          r2-cloud.nixosModules.default
          {
            services.r2-sync.enable = false;
          }
        ];
      };
    };
}
