{
  description = "Standalone Cloudflare R2 flake (Phase 1 scaffold)";
  nixConfig = {
    extra-substituters = [
      "https://nix-r2-cloudflare-flake.cachix.org"
      "https://wrangler.cachix.org"
    ];
    extra-trusted-public-keys = [
      "nix-r2-cloudflare-flake.cachix.org-1:pmYucG85iBm6Y+8TxNwqU5j/lmY1UBReZxIXslMFntw="
      "wrangler.cachix.org-1:N/FIcG2qBQcolSpklb2IMDbsfjZKWg+ctxx0mSMXdSs="
    ];
  };

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    flake-parts.url = "github:hercules-ci/flake-parts";
    wrangler.url = "github:emrldnix/wrangler";
  };

  outputs =
    inputs@{
      self,
      nixpkgs,
      flake-parts,
      wrangler,
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
          system,
          ...
        }:
        let
          optionalPkg = name: if builtins.hasAttr name pkgs then [ pkgs.${name} ] else [ ];
          optionalNodePkg =
            name:
            if builtins.hasAttr "nodePackages" pkgs && builtins.hasAttr name pkgs.nodePackages then
              [ pkgs.nodePackages.${name} ]
            else
              [ ];
          wranglerPkg = wrangler.packages.${system}.default;
          formatterPkg =
            if builtins.hasAttr "treefmt" pkgs then
              pkgs.writeShellApplication {
                name = "treefmt-wrapper";
                runtimeInputs =
                  optionalPkg "treefmt"
                  ++ optionalPkg "nixfmt"
                  ++ optionalPkg "shfmt"
                  ++ optionalNodePkg "prettier"
                  ++ optionalPkg "taplo"
                  ++ optionalPkg "actionlint";
                text = ''
                  set -euo pipefail
                  exec treefmt "$@"
                '';
              }
            else
              pkgs.nixfmt;
          hookToolPackages =
            optionalPkg "lefthook"
            ++ optionalPkg "deadnix"
            ++ optionalPkg "statix"
            ++ optionalPkg "treefmt"
            ++ optionalPkg "nixfmt"
            ++ optionalPkg "shfmt"
            ++ optionalNodePkg "prettier"
            ++ optionalPkg "taplo"
            ++ optionalPkg "actionlint"
            ++ optionalPkg "yamllint"
            ++ optionalPkg "ripsecrets"
            ++ [
              self.packages.${system}.lefthook-treefmt
              self.packages.${system}.lefthook-statix
            ];
          hookShellSetup = ''
            treefmt_cache="$PWD/.git/treefmt-cache/cache"
            mkdir -p "$treefmt_cache" 2>/dev/null || true
            export TREEFMT_CACHE_DB="$treefmt_cache/eval-cache"

            if command -v lefthook >/dev/null 2>&1; then
              if [ ! -f .git/hooks/pre-commit ] || ! grep -q "lefthook" .git/hooks/pre-commit 2>/dev/null; then
                lefthook install
              fi
            fi
          '';
          r2Package = pkgs.callPackage ./packages/r2-cli.nix { wrangler = wranglerPkg; };
        in
        {
          packages = {
            r2 = r2Package;
            lefthook-treefmt = pkgs.writeShellApplication {
              name = "lefthook-treefmt";
              runtimeInputs = [
                pkgs.coreutils
              ]
              ++ optionalPkg "git"
              ++ optionalPkg "treefmt";
              text = ''
                set -euo pipefail

                mapfile -t changed < <(
                  {
                    git diff --name-only HEAD --diff-filter=ACM 2>/dev/null || true
                    git ls-files --others --exclude-standard 2>/dev/null || true
                  } | sort -u
                )
                if [ "''${#changed[@]}" -eq 0 ]; then
                  exit 0
                fi

                treefmt --fail-on-change "''${changed[@]}"
              '';
            };
            lefthook-statix = pkgs.writeShellApplication {
              name = "lefthook-statix";
              runtimeInputs = [
                pkgs.coreutils
              ]
              ++ optionalPkg "statix";
              text = ''
                set -euo pipefail

                if [ "$#" -eq 0 ]; then
                  statix check --format errfmt
                  exit 0
                fi

                status=0
                for file in "$@"; do
                  if [ -f "$file" ]; then
                    statix check --format errfmt "$file" || status=$?
                  fi
                done
                exit "$status"
              '';
            };

            default = pkgs.symlinkJoin {
              name = "r2-cloud-tools";
              paths = [
                self.packages.${system}.r2
                self.packages.${system}.lefthook-treefmt
                self.packages.${system}.lefthook-statix
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
            ++ hookToolPackages
            ++ [ wranglerPkg ];

            shellHook = hookShellSetup;
          };
          devShells.hooks = pkgs.mkShell {
            packages = [
              pkgs.coreutils
              pkgs.git
            ]
            ++ hookToolPackages
            ++ optionalPkg "vulnix";
            shellHook = hookShellSetup;
          };

          formatter = formatterPkg;
        };
    };
}
