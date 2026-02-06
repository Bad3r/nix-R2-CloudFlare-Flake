{
  lib,
  writeShellApplication,
  coreutils,
  rclone,
  wrangler ? null,
}:
writeShellApplication {
  name = "r2";
  runtimeInputs = [
    coreutils
    rclone
  ]
  ++ lib.optionals (wrangler != null) [ wrangler ];
  text = ''
        set -euo pipefail

        credentials_file=""
        default_credentials_file="$HOME/.config/cloudflare/r2/env"
        default_rclone_config="$HOME/.config/rclone/rclone.conf"

        usage_main() {
          cat <<'USAGE'
    Usage: r2 <command> [args]

    Commands:
      bucket <subcommand> ...      Manage R2 buckets with wrangler
      share <bucket> <key> [exp]   Generate presigned object URL
      rclone <args...>             Run rclone with managed config path
      help                         Show this help

    Examples:
      r2 bucket list
      r2 bucket create documents
      r2 share documents report.pdf 24h
      r2 rclone ls r2:documents/
    USAGE
        }

        usage_bucket() {
          cat <<'USAGE'
    Usage: r2 bucket <subcommand> [args]

    Subcommands:
      create <name>         Create a bucket
      list                  List buckets
      delete <name>         Delete bucket (interactive confirm)
      lifecycle <name> [d]  Set .trash/ retention days (default: 30)
      help                  Show this help
    USAGE
        }

        usage_share() {
          cat <<'USAGE'
    Usage: r2 share <bucket> <key> [expiry]

    Generate a presigned URL on the Cloudflare R2 S3 endpoint.
    Default expiry is 24h.
    USAGE
        }

        usage_rclone() {
          cat <<'USAGE'
    Usage: r2 rclone <rclone-args...>

    Runs:
      rclone --config "$R2_RCLONE_CONFIG_OR_DEFAULT" <rclone-args...>
    USAGE
        }

        fail() {
          echo "Error: $*" >&2
          exit 1
        }

        load_credentials() {
          local default_account_id account_id

          credentials_file="''${R2_CREDENTIALS_FILE:-$default_credentials_file}"
          default_account_id="''${R2_DEFAULT_ACCOUNT_ID:-}"

          if [[ ! -r "$credentials_file" ]]; then
            fail "credentials file is missing or unreadable: $credentials_file"
          fi

          set -a
          # shellcheck source=/dev/null
          source "$credentials_file"
          set +a

          account_id="''${R2_ACCOUNT_ID:-$default_account_id}"
          if [[ -z "$account_id" ]]; then
            fail "R2 account ID is missing. Set R2_ACCOUNT_ID in credentials file or R2_DEFAULT_ACCOUNT_ID."
          fi

          export R2_ACCOUNT_ID="$account_id"
          export CLOUDFLARE_ACCOUNT_ID="$account_id"
        }

        ensure_aws_credentials() {
          if [[ -z "''${AWS_ACCESS_KEY_ID:-}" ]]; then
            fail "AWS_ACCESS_KEY_ID is missing in credentials file: $credentials_file"
          fi
          if [[ -z "''${AWS_SECRET_ACCESS_KEY:-}" ]]; then
            fail "AWS_SECRET_ACCESS_KEY is missing in credentials file: $credentials_file"
          fi
        }

        ensure_wrangler() {
          if ! command -v wrangler >/dev/null 2>&1; then
            fail "wrangler is not available. Install wrangler or include it in your runtime environment."
          fi
        }

        run_bucket_create() {
          local name="''${1:-}"
          [[ -n "$name" ]] || fail "bucket name is required (usage: r2 bucket create <name>)"

          load_credentials
          ensure_wrangler
          wrangler r2 bucket create "$name"
          echo "Created bucket: $name"
        }

        run_bucket_list() {
          load_credentials
          ensure_wrangler
          wrangler r2 bucket list
        }

        run_bucket_delete() {
          local name="''${1:-}"
          [[ -n "$name" ]] || fail "bucket name is required (usage: r2 bucket delete <name>)"

          load_credentials
          ensure_wrangler

          read -r -p "Delete bucket '$name'? [y/N] " confirm
          if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
            echo "Cancelled"
            exit 0
          fi

          wrangler r2 bucket delete "$name"
          echo "Deleted bucket: $name"
        }

        run_bucket_lifecycle() {
          local name="''${1:-}"
          local days="''${2:-30}"
          local rules_file=""

          [[ -n "$name" ]] || fail "bucket name is required (usage: r2 bucket lifecycle <name> [days])"
          [[ "$days" =~ ^[0-9]+$ ]] || fail "retention days must be a non-negative integer (got '$days')."

          load_credentials
          ensure_wrangler

          rules_file="$(mktemp)"
          trap 'rm -f "$rules_file"' RETURN

          cat > "$rules_file" <<JSON
    {"rules":[{"id":"trash-cleanup","prefix":".trash/","expiration":{"days":$days}}]}
    JSON

          wrangler r2 bucket lifecycle set "$name" --file "$rules_file"
          echo "Set .trash/ retention to $days days for bucket: $name"
        }

        run_share() {
          local bucket="''${1:-}"
          local key="''${2:-}"
          local expiry="''${3:-24h}"

          [[ -n "$bucket" ]] || fail "bucket is required (usage: r2 share <bucket> <key> [expiry])"
          [[ -n "$key" ]] || fail "key is required (usage: r2 share <bucket> <key> [expiry])"

          load_credentials
          ensure_aws_credentials

          exec rclone link \
            --config=/dev/null \
            --s3-provider=Cloudflare \
            --s3-endpoint="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com" \
            --s3-access-key-id="$AWS_ACCESS_KEY_ID" \
            --s3-secret-access-key="$AWS_SECRET_ACCESS_KEY" \
            --expire="$expiry" \
            ":s3:$bucket/$key"
        }

        run_rclone() {
          local config_path
          config_path="''${R2_RCLONE_CONFIG:-$default_rclone_config}"

          [[ "$#" -gt 0 ]] || {
            usage_rclone >&2
            exit 1
          }

          load_credentials
          [[ -r "$config_path" ]] || fail "rclone config is missing or unreadable: $config_path"

          exec rclone --config "$config_path" "$@"
        }

        run_bucket() {
          local subcommand="''${1:-help}"
          shift || true

          case "$subcommand" in
            create)
              [[ "$#" -eq 1 ]] || fail "usage: r2 bucket create <name>"
              run_bucket_create "$1"
              ;;
            list)
              [[ "$#" -eq 0 ]] || fail "usage: r2 bucket list"
              run_bucket_list
              ;;
            delete)
              [[ "$#" -eq 1 ]] || fail "usage: r2 bucket delete <name>"
              run_bucket_delete "$1"
              ;;
            lifecycle)
              [[ "$#" -ge 1 && "$#" -le 2 ]] || fail "usage: r2 bucket lifecycle <name> [days]"
              run_bucket_lifecycle "$@"
              ;;
            help|-h|--help)
              usage_bucket
              ;;
            *)
              fail "unknown bucket subcommand '$subcommand'"
              ;;
          esac
        }

        cmd="''${1:-help}"
        shift || true

        case "$cmd" in
          bucket)
            run_bucket "$@"
            ;;
          share)
            if [[ "''${1:-}" =~ ^(-h|--help|help)$ ]]; then
              usage_share
            else
              [[ "$#" -ge 2 && "$#" -le 3 ]] || fail "usage: r2 share <bucket> <key> [expiry]"
              run_share "$@"
            fi
            ;;
          rclone)
            if [[ "''${1:-}" =~ ^(-h|--help|help)$ ]]; then
              usage_rclone
            else
              run_rclone "$@"
            fi
            ;;
          help|-h|--help)
            usage_main
            ;;
          *)
            fail "unknown command '$cmd' (run: r2 help)"
            ;;
        esac
  '';
}
