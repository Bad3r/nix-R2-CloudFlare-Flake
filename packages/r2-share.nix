{ writeShellApplication }:
writeShellApplication {
  name = "r2-share";
  text = ''
        set -euo pipefail

        cmd="''${1:-help}"

        case "$cmd" in
          help|-h|--help)
            cat <<'USAGE'
    Usage: r2-share <bucket> <key> [expiry]

    Package placeholder for Phase 4:
      CLI package extraction/refactor from Stage 3 Home Manager wrappers.

    Target behavior (to be implemented in this package):
      Generate presigned links for R2 objects.

    Current availability:
      Functional r2-share is provided by the Stage 3 Home Manager wrapper
      (`programs.r2-cloud.enable = true`).
    USAGE
            ;;
          *)
            echo "r2-share package placeholder: pending Phase 4 package extraction/refactor." >&2
            exit 2
            ;;
        esac
  '';
}
