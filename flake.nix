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
    # No `follows` overrides here: rewriting wrangler's inputs changes its
    # derivation hashes, which defeats the wrangler.cachix.org substituter
    # configured above and forces a from-source wrangler build. Using its own
    # locked inputs also keeps this flake and ./r2-explorer (which likewise
    # does not override) on one identical wrangler derivation.
    wrangler.url = "github:emrldnix/wrangler";
    # Only consumed by ./default.nix for non-flake `nix-build` / `import ./.`.
    flake-compat = {
      url = "github:edolstra/flake-compat";
      flake = false;
    };
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

        lib =
          let
            r2Lib = import ./lib/r2.nix { inherit (nixpkgs) lib; };
            versionLib = import ./lib/version.nix { inherit (nixpkgs) lib; };
          in
          r2Lib // versionLib;
      };

      perSystem =
        {
          pkgs,
          system,
          ...
        }:
        let
          inherit (pkgs) lib;
          # Only for tools that genuinely may be missing on a supported system
          # (git-annex); everything else is referenced directly.
          optionalPkg = name: if builtins.hasAttr name pkgs then [ pkgs.${name} ] else [ ];
          wranglerPkg = wrangler.packages.${system}.default;
          formatterPkg = pkgs.writeShellApplication {
            name = "treefmt-wrapper";
            runtimeInputs = [
              pkgs.treefmt
              pkgs.nixfmt
              pkgs.shfmt
              pkgs.prettier
              pkgs.taplo
              pkgs.actionlint
            ];
            text = ''
              set -euo pipefail
              exec treefmt "$@"
            '';
          };
          versionLib = import ./lib/version.nix { inherit lib; };
          inherit (versionLib) releaseBase;
          r2DerivationVersion = versionLib.mkDerivationVersion {
            inherit releaseBase;
            sourceInfo = self.sourceInfo or null;
            rev = self.rev or null;
            shortRev = self.shortRev or null;
            dirtyRev = self.dirtyRev or null;
            dirtyShortRev = self.dirtyShortRev or null;
            src = ./.;
          };
          hookToolPackages = [
            pkgs.lefthook
            pkgs.deadnix
            pkgs.statix
            pkgs.treefmt
            pkgs.nixfmt
            pkgs.shfmt
            pkgs.prettier
            pkgs.taplo
            pkgs.actionlint
            pkgs.yamllint
            pkgs.ripsecrets
            self.packages.${system}.lefthook-treefmt
            self.packages.${system}.lefthook-statix
          ];
          hookShellSetup = ''
            treefmt_cache="$(git rev-parse --git-path treefmt-cache/cache 2>/dev/null || echo "$PWD/.git/treefmt-cache/cache")"
            mkdir -p "$treefmt_cache" 2>/dev/null || true
            export TREEFMT_CACHE_DB="$treefmt_cache/eval-cache"

            if command -v lefthook >/dev/null 2>&1; then
              pre_commit_hook="$(git rev-parse --git-path hooks/pre-commit 2>/dev/null || echo ".git/hooks/pre-commit")"
              if [ ! -f "$pre_commit_hook" ] || ! grep -q "lefthook" "$pre_commit_hook" 2>/dev/null; then
                lefthook install
              fi
            fi
          '';
          r2Package = pkgs.callPackage ./packages/r2-cli.nix {
            wrangler = wranglerPkg;
            derivationVersion = r2DerivationVersion;
            inherit releaseBase;
          };
        in
        {
          packages = {
            r2 = r2Package;
            lefthook-treefmt = pkgs.writeShellApplication {
              name = "lefthook-treefmt";
              runtimeInputs = [
                pkgs.coreutils
                pkgs.git
                pkgs.treefmt
              ];
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
                pkgs.statix
              ];
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

          # Eval-level regression check: builds trivially, but forces module
          # evaluation (assertions, generated unit scripts) for a representative
          # configuration of every NixOS module in this flake.
          checks = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            nixos-module-eval =
              let
                eval = nixpkgs.lib.nixosSystem {
                  inherit system;
                  modules = [
                    self.nixosModules.default
                    {
                      system.stateVersion = "25.05";
                      # Eval-only defaults so base NixOS assertions pass.
                      fileSystems."/" = {
                        device = "tmpfs";
                        fsType = "tmpfs";
                      };
                      boot.loader.grub.devices = [ "nodev" ];

                      programs.fuse.userAllowOther = true;
                      services.r2-sync = {
                        enable = true;
                        accountId = "abc123";
                        credentialsFile = "/run/secrets/r2/credentials.env";
                        mounts.documents = {
                          bucket = "documents";
                          remotePrefix = "documents";
                          mountPoint = "/data/r2/mount/documents";
                          localPath = "/data/r2/documents";
                        };
                      };
                      services.r2-restic = {
                        enable = true;
                        accountId = "abc123";
                        credentialsFile = "/run/secrets/r2/credentials.env";
                        passwordFile = "/run/secrets/r2/restic-password";
                        bucket = "backups";
                        paths = [ "/data/r2/documents" ];
                      };
                      programs.git-annex-r2 = {
                        enable = true;
                        credentialsFile = "/run/secrets/r2/credentials.env";
                      };
                    }
                  ];
                };
                failed = builtins.filter (a: !a.assertion) eval.config.assertions;
                failedMessages = builtins.concatStringsSep "; " (map (a: a.message) failed);
                units = eval.config.systemd.services;
                bisyncTimerConfig = eval.config.systemd.timers."r2-bisync-documents".timerConfig;
                # toString forces script derivation instantiation without
                # recursing into self-referential derivation attrsets.
                forced = builtins.deepSeq {
                  mountExecStart = toString units."r2-mount-documents".serviceConfig.ExecStart;
                  mountExecStop = toString units."r2-mount-documents".serviceConfig.ExecStop;
                  bisyncExecStart = toString units."r2-bisync-documents".serviceConfig.ExecStart;
                  bisyncInterval = toString bisyncTimerConfig.OnUnitActiveSec;
                  # Persistent= is a no-op on monotonic timers; keep it out.
                  bisyncTimerNotPersistent =
                    if bisyncTimerConfig ? Persistent then
                      throw "r2-bisync timer must not set Persistent= (no-op for monotonic OnActiveSec/OnUnitActiveSec timers)"
                    else
                      "ok";
                  resticExecStartPre = toString units.r2-restic-backup.serviceConfig.ExecStartPre;
                  resticExecStart = toString units.r2-restic-backup.serviceConfig.ExecStart;
                } "ok";
              in
              if failed != [ ] then
                throw "nixos-module-eval check failed assertions: ${failedMessages}"
              else
                pkgs.writeText "r2-nixos-module-eval" forced;
          };

          devShells.default = pkgs.mkShell {
            packages = [
              pkgs.rclone
              pkgs.restic
              pkgs.nodejs
              pkgs.jq
              pkgs.python3
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
              pkgs.python3
            ]
            ++ hookToolPackages;
            shellHook = hookShellSetup;
          };

          formatter = formatterPkg;
        };
    };
}
