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
      # working directory (repo root or r2-explorer/). Only the API worker
      # root qualifies: r2-explorer/web/ also holds a wrangler.toml +
      # package.json pair, and accepting it would silently deploy the web
      # worker, so the locator requires the API config's name.
      locateCheckoutSnippet = ''
        is_api_checkout() {
          [[ -f "$1/wrangler.toml" && -f "$1/package.json" ]] || return 1
          grep -Eq '^name[[:space:]]*=[[:space:]]*"r2-explorer"' "$1/wrangler.toml"
        }
        src_dir="''${R2_EXPLORER_SRC:-}"
        if [[ -z "$src_dir" ]]; then
          for candidate in "$PWD" "$PWD/r2-explorer"; do
            if is_api_checkout "$candidate"; then
              src_dir="$candidate"
              break
            fi
          done
        fi
        if [[ -z "$src_dir" ]]; then
          echo "Error: unable to locate the r2-explorer API checkout." >&2
          echo "Run from the repository root or r2-explorer/, or set R2_EXPLORER_SRC to the checkout path." >&2
          exit 1
        fi
        if ! is_api_checkout "$src_dir"; then
          found_name="$(grep -E '^name[[:space:]]*=' "$src_dir/wrangler.toml" 2>/dev/null | head -n 1 || true)"
          echo "Error: '$src_dir' is not the r2-explorer API checkout (need wrangler.toml with name = \"r2-explorer\"; found: ''${found_name:-no wrangler.toml})." >&2
          echo "From r2-explorer/web/, run the deploy against the parent directory instead." >&2
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
