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

    Generates a presigned link (planned for Phase 4).
    USAGE
            ;;
          *)
            echo "r2-share is not implemented yet (Phase 4)." >&2
            exit 2
            ;;
        esac
  '';
}
