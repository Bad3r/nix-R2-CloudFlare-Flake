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

      # Deploys must run from a writable checkout: the flake source packaged
      # into /nix/store is read-only, so `pnpm install` and web builds cannot
      # run there. Resolve the checkout from $R2_EXPLORER_SRC or the caller's
      # working directory (repo root or r2-explorer/).
      locateCheckoutSnippet = ''
        src_dir="''${R2_EXPLORER_SRC:-}"
        if [[ -z "$src_dir" ]]; then
          for candidate in "$PWD" "$PWD/r2-explorer"; do
            if [[ -f "$candidate/wrangler.toml" && -f "$candidate/package.json" ]]; then
              src_dir="$candidate"
              break
            fi
          done
        fi
        if [[ -z "$src_dir" || ! -f "$src_dir/wrangler.toml" || ! -f "$src_dir/package.json" ]]; then
          echo "Error: unable to locate the r2-explorer checkout." >&2
          echo "Run from the repository root or r2-explorer/, or set R2_EXPLORER_SRC to the checkout path." >&2
          exit 1
        fi
        cd "$src_dir"
      '';
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs
            pkgs.pnpm
            pkgs.jq
            wrangler.packages.${pkgs.stdenv.hostPlatform.system}.default
          ];
        };
      });

      packages = forAllSystems (
        pkgs:
        let
          wranglerPkg = wrangler.packages.${pkgs.stdenv.hostPlatform.system}.default;
          deployTools = [
            pkgs.nodejs
            pkgs.pnpm
            pkgs.jq
            wranglerPkg
          ];
        in
        {
          deploy = pkgs.writeShellApplication {
            name = "deploy-r2-explorer";
            runtimeInputs = deployTools;
            text = ''
              set -euo pipefail

              # Wrangler needs Cloudflare auth: set CLOUDFLARE_API_TOKEN (and
              # CLOUDFLARE_ACCOUNT_ID for multi-account tokens) or run
              # `wrangler login` beforehand.
              ${locateCheckoutSnippet}
              pnpm install
              wrangler deploy "$@"
            '';
          };

          deploy-web = pkgs.writeShellApplication {
            name = "deploy-r2-explorer-web";
            runtimeInputs = deployTools;
            text = ''
              set -euo pipefail

              # Wrangler needs Cloudflare auth: set CLOUDFLARE_API_TOKEN (and
              # CLOUDFLARE_ACCOUNT_ID for multi-account tokens) or run
              # `wrangler login` beforehand.
              ${locateCheckoutSnippet}
              pnpm install
              pnpm -C web run build
              cp web/.assetsignore web/dist/.assetsignore
              wrangler deploy --config web/wrangler.toml "$@"
            '';
          };

          default = pkgs.writeShellApplication {
            name = "r2-explorer-status";
            text = ''
              set -euo pipefail
              echo "R2-Explorer API + web UI are implemented."
              echo "Use deploy-r2-explorer for the API Worker."
              echo "Use deploy-r2-explorer-web for the Astro web Worker."
              echo "Both run from your checkout (repo root, r2-explorer/, or R2_EXPLORER_SRC)"
              echo "and need Cloudflare auth (CLOUDFLARE_API_TOKEN or wrangler login)."
            '';
          };
        }
      );
    };
}
