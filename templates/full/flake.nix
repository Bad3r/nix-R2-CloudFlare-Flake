{
  description = "Full R2 cloud scaffold consumer";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
    r2-cloud.url = "github:username/r2-cloud-nix";
  };

  outputs =
    {
      nixpkgs,
      home-manager,
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
            services.r2-restic.enable = false;
            programs.git-annex-r2.enable = false;
          }
        ];
      };

      homeConfigurations.example = home-manager.lib.homeManagerConfiguration {
        pkgs = nixpkgs.legacyPackages.x86_64-linux;
        modules = [
          r2-cloud.homeManagerModules.default
          {
            programs.r2-cloud.enable = false;
          }
        ];
      };
    };
}
