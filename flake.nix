{
  description = "Standalone Cloudflare R2 flake (Phase 1 scaffold)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs =
    inputs@{
      self,
      nixpkgs,
      flake-parts,
      ...
    }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      flake = {
        nixosModules = {
          default = import ./modules/nixos;
          r2-sync = import ./modules/nixos/r2-sync.nix;
          r2-restic = import ./modules/nixos/r2-restic.nix;
          git-annex = import ./modules/nixos/git-annex.nix;
        };

        homeManagerModules = {
          default = import ./modules/home-manager;
          r2-cli = import ./modules/home-manager/r2-cli.nix;
          r2-credentials = import ./modules/home-manager/r2-credentials.nix;
          rclone-config = import ./modules/home-manager/rclone-config.nix;
        };

        templates = {
          minimal = {
            path = ./templates/minimal;
            description = "Minimal R2 scaffold template";
          };
          full = {
            path = ./templates/full;
            description = "Full R2 scaffold template";
          };
        };

        lib = import ./lib/r2.nix { inherit (nixpkgs) lib; };
      };

      perSystem =
        {
          pkgs,
          lib,
          system,
          ...
        }:
        let
          optionalPkg = name: if builtins.hasAttr name pkgs then [ pkgs.${name} ] else [ ];
          wranglerPkg =
            if builtins.hasAttr "nodePackages" pkgs && builtins.hasAttr "wrangler" pkgs.nodePackages then
              pkgs.nodePackages.wrangler
            else if builtins.hasAttr "wrangler" pkgs then
              pkgs.wrangler
            else
              null;
          formatterPkg = pkgs.nixfmt;
        in
        {
          packages = {
            r2-bucket = pkgs.callPackage ./packages/r2-bucket.nix { };
            r2-cli = pkgs.callPackage ./packages/r2-cli.nix { };
            r2-share = pkgs.callPackage ./packages/r2-share.nix { };

            default = pkgs.symlinkJoin {
              name = "r2-cloud-tools";
              paths = [
                self.packages.${system}.r2-bucket
                self.packages.${system}.r2-cli
                self.packages.${system}.r2-share
              ];
            };
          };

          devShells.default = pkgs.mkShell {
            packages = [
              pkgs.rclone
              pkgs.restic
              pkgs.nodejs
              pkgs.jq
            ]
            ++ optionalPkg "git-annex"
            ++ lib.optional (wranglerPkg != null) wranglerPkg;
          };

          formatter = formatterPkg;
        };
    };
}
