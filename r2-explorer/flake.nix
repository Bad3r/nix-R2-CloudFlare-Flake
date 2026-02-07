{
  description = "R2-Explorer Worker subflake";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
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
            wranglerPkg =
              if hasNodePackages && builtins.hasAttr "wrangler" pkgs.nodePackages then
                pkgs.nodePackages.wrangler
              else if builtins.hasAttr "wrangler" pkgs then
                pkgs.wrangler
              else
                null;
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
            ++ pkgs.lib.optional (wranglerPkg != null) wranglerPkg;
          };
      });

      packages = forAllSystems (
        pkgs:
        let
          hasNodePackages = builtins.hasAttr "nodePackages" pkgs;
          wranglerPkg =
            if hasNodePackages && builtins.hasAttr "wrangler" pkgs.nodePackages then
              pkgs.nodePackages.wrangler
            else if builtins.hasAttr "wrangler" pkgs then
              pkgs.wrangler
            else
              null;
          pnpmPkg =
            if hasNodePackages && builtins.hasAttr "pnpm" pkgs.nodePackages then
              pkgs.nodePackages.pnpm
            else if builtins.hasAttr "pnpm" pkgs then
              pkgs.pnpm
            else
              null;
          pnpmCmd = if pnpmPkg != null then "${pnpmPkg}/bin/pnpm" else "pnpm";
          wranglerCmd = if wranglerPkg != null then "${wranglerPkg}/bin/wrangler" else "wrangler";
        in
        {
          deploy = pkgs.writeShellApplication {
            name = "deploy-r2-explorer";
            runtimeInputs = [
              pkgs.nodejs
              pkgs.jq
            ]
            ++ pkgs.lib.optional (pnpmPkg != null) pnpmPkg
            ++ pkgs.lib.optional (wranglerPkg != null) wranglerPkg;
            text = ''
              set -euo pipefail

              cd ${./.}
              ${pnpmCmd} install
              ${wranglerCmd} deploy "$@"
            '';
          };

          default = pkgs.writeShellApplication {
            name = "r2-explorer-status";
            text = ''
              set -euo pipefail
              echo "R2-Explorer Worker (Phase 5) is implemented."
              echo "Use deploy-r2-explorer to publish via wrangler."
            '';
          };
        }
      );
    };
}
