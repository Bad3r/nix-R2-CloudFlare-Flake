# Flake-compat shim so `nix-build` and `import ./.` work without the flakes
# feature. flake-compat is pinned through flake.lock (inputs.flake-compat).
# Evaluates to the same package as `nix build .#default`.
let
  lock = builtins.fromJSON (builtins.readFile ./flake.lock);
  flakeCompatNode = lock.nodes.flake-compat.locked;
  flakeCompat = fetchTarball {
    url = "https://github.com/${flakeCompatNode.owner}/${flakeCompatNode.repo}/archive/${flakeCompatNode.rev}.tar.gz";
    sha256 = flakeCompatNode.narHash;
  };
  flake = (import flakeCompat { src = ./.; }).defaultNix;
in
flake.packages.${builtins.currentSystem}.default
