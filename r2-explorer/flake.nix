{
  description = "R2-Explorer Worker subflake (Phase 1 scaffold)";

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
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs
          ]
          ++ (
            if builtins.hasAttr "nodePackages" pkgs && builtins.hasAttr "wrangler" pkgs.nodePackages then
              [ pkgs.nodePackages.wrangler ]
            else
              [ ]
          );
        };
      });

      packages = forAllSystems (pkgs: {
        deploy = pkgs.writeShellApplication {
          name = "deploy-r2-explorer";
          text = ''
            echo "R2-Explorer deploy pipeline is not implemented yet (Phase 5/7)." >&2
            exit 2
          '';
        };

        default = pkgs.writeShellApplication {
          name = "r2-explorer-status";
          text = ''
            echo "R2-Explorer scaffold exists; Worker implementation is pending (Phase 5)."
          '';
        };
      });
    };
}
