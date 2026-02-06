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

    Commands:
      create <name>       Create bucket (Phase 4)
      list                List buckets (Phase 4)
      delete <name>       Delete bucket (Phase 4)
      lifecycle <name>    Configure lifecycle (Phase 4)
    USAGE
            ;;
          *)
            echo "r2-bucket: command '$cmd' is not implemented yet (Phase 4)." >&2
            exit 2
            ;;
        esac
  '';
}
