{
  description = "R2-Explorer Worker subflake";
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
    wrangler.url = "github:emrldnix/wrangler";
  };

  outputs =
    { nixpkgs, wrangler, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default =
          let
            hasNodePackages = builtins.hasAttr "nodePackages" pkgs;
            wranglerPkg = wrangler.packages.${pkgs.system}.default;
            pnpmPkg =
              if hasNodePackages && builtins.hasAttr "pnpm" pkgs.nodePackages then
                pkgs.nodePackages.pnpm
              else if builtins.hasAttr "pnpm" pkgs then
                pkgs.pnpm
              else
                null;
          in
          pkgs.mkShell {
            packages = [
              pkgs.nodejs
              pkgs.jq
            ]
            ++ pkgs.lib.optional (pnpmPkg != null) pnpmPkg
            ++ [ wranglerPkg ];
          };
      });

      packages = forAllSystems (
        pkgs:
        let
          hasNodePackages = builtins.hasAttr "nodePackages" pkgs;
          wranglerPkg = wrangler.packages.${pkgs.system}.default;
          pnpmPkg =
            if hasNodePackages && builtins.hasAttr "pnpm" pkgs.nodePackages then
              pkgs.nodePackages.pnpm
            else if builtins.hasAttr "pnpm" pkgs then
              pkgs.pnpm
            else
              null;
          pnpmCmd = if pnpmPkg != null then "${pnpmPkg}/bin/pnpm" else "pnpm";
          wranglerCmd = "${wranglerPkg}/bin/wrangler";
        in
        {
          deploy = pkgs.writeShellApplication {
            name = "deploy-r2-explorer";
            runtimeInputs = [
              pkgs.nodejs
              pkgs.jq
            ]
            ++ pkgs.lib.optional (pnpmPkg != null) pnpmPkg
            ++ [ wranglerPkg ];
            text = ''
              set -euo pipefail

              cd ${./.}
              ${pnpmCmd} install
              ${wranglerCmd} deploy "$@"
            '';
          };

          deploy-web = pkgs.writeShellApplication {
            name = "deploy-r2-explorer-web";
            runtimeInputs = [
              pkgs.nodejs
              pkgs.jq
            ]
            ++ pkgs.lib.optional (pnpmPkg != null) pnpmPkg
            ++ [ wranglerPkg ];
            text = ''
              set -euo pipefail

              cd ${./.}
              ${pnpmCmd} install
              ${pnpmCmd} -C web run build
              ${wranglerCmd} deploy --config web/wrangler.toml "$@"
            '';
          };

          default = pkgs.writeShellApplication {
            name = "r2-explorer-status";
            text = ''
              set -euo pipefail
              echo "R2-Explorer API + web UI are implemented."
              echo "Use deploy-r2-explorer for the API Worker."
              echo "Use deploy-r2-explorer-web for the Astro web Worker."
            '';
          };
        }
      );
    };
}
