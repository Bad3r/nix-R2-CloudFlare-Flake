{ writeShellApplication }:
writeShellApplication {
  name = "r2-cli";
  text = ''
        set -euo pipefail

        cmd="''${1:-help}"

        case "$cmd" in
          help|-h|--help)
            cat <<'USAGE'
    Usage: r2-cli <command> [args]

    Commands:
      mount        Placeholder for mount workflows (Phase 2)
      sync         Placeholder for bisync workflows (Phase 2)
      share        Placeholder for share workflows (Phase 4/5)
    USAGE
            ;;
          *)
            echo "r2-cli: command '$cmd' is not implemented yet." >&2
            exit 2
            ;;
        esac
  '';
}
