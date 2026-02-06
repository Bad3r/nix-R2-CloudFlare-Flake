{ writeShellApplication }:
writeShellApplication {
  name = "r2-bucket";
  text = ''
        set -euo pipefail

        cmd="''${1:-help}"

        case "$cmd" in
          help|-h|--help)
            cat <<'USAGE'
    Usage: r2-bucket <command> [args]

    Package placeholder for Phase 4:
      CLI package extraction/refactor from Stage 3 Home Manager wrappers.

    Target command surface (to be implemented in this package):
      create <name>       Create a new bucket
      list                List all buckets
      delete <name>       Delete a bucket
      lifecycle <name>    Configure .trash/ lifecycle retention

    Current availability:
      Functional r2-bucket is provided by the Stage 3 Home Manager wrapper
      (`programs.r2-cloud.enable = true`).
    USAGE
            ;;
          *)
            echo "r2-bucket package placeholder: command '$cmd' is pending Phase 4 package extraction/refactor." >&2
            exit 2
            ;;
        esac
  '';
}
