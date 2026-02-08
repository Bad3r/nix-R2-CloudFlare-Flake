{
  lib,
  writeShellApplication,
  coreutils,
  curl,
  gawk,
  jq,
  openssl,
  rclone,
  wrangler ? null,
}:
writeShellApplication {
  name = "r2";
  runtimeInputs = [
    coreutils
    curl
    gawk
    jq
    openssl
    rclone
  ]
  ++ lib.optionals (wrangler != null) [ wrangler ];
  text = ''
    set -euo pipefail

    credentials_file=""
    default_credentials_file="$HOME/.config/cloudflare/r2/env"
    default_rclone_config="$HOME/.config/rclone/rclone.conf"

    usage_main() {
      printf '%s\n' \
        "Usage: r2 <command> [args]" \
        "" \
        "Commands:" \
        "  bucket <subcommand> ...              Manage R2 buckets with wrangler" \
        "  share <bucket> <key> [exp]           Generate presigned object URL" \
        "  share worker <subcommand> ...        Manage Worker share tokens" \
        "  rclone <args...>                     Run rclone with managed config path" \
        "  help                                 Show this help" \
        "" \
        "Examples:" \
        "  r2 bucket list" \
        "  r2 share documents report.pdf 24h" \
        "  r2 share worker create files report.pdf 7d --max-downloads 5" \
        "  r2 rclone ls r2:documents/"
    }

    usage_bucket() {
      printf '%s\n' \
        "Usage: r2 bucket <subcommand> [args]" \
        "" \
        "Subcommands:" \
        "  create <name>         Create a bucket" \
        "  list                  List buckets" \
        "  delete <name>         Delete bucket (interactive confirm)" \
        "  lifecycle <name> [d]  Set .trash/ retention days (default: 30)" \
        "  help                  Show this help"
    }

    usage_share() {
      printf '%s\n' \
        "Usage:" \
        "  r2 share <bucket> <key> [expiry]" \
        "  r2 share worker <subcommand> ..." \
        "" \
        "Presigned mode:" \
        "  Generates an S3 endpoint URL via rclone link." \
        "  Default expiry is 24h." \
        "" \
        "Worker mode subcommands:" \
        "  create <bucket> <key> [ttl] [--max-downloads N]" \
        "  revoke <token-id>" \
        "  list <bucket> <key>" \
        "  help"
    }

    usage_share_worker() {
      printf '%s\n' \
        "Usage: r2 share worker <subcommand> [args]" \
        "" \
        "Subcommands:" \
        "  create <bucket> <key> [ttl] [--max-downloads N]" \
        "  revoke <token-id>" \
        "  list <bucket> <key>" \
        "  help" \
        "" \
        "Required environment variables:" \
        "  R2_EXPLORER_BASE_URL     e.g. https://files.example.com" \
        "  R2_EXPLORER_ADMIN_KID    key id from R2E_KEYS_KV keyset" \
        "  R2_EXPLORER_ADMIN_SECRET key material (plain text or base64 value)"
    }

    usage_rclone() {
      printf '%s\n' \
        "Usage: r2 rclone <rclone-args...>" \
        "" \
        "Runs:" \
        "  rclone --config \"\$R2_RCLONE_CONFIG_OR_DEFAULT\" <rclone-args...>"
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

    ensure_worker_share_env() {
      if [[ -z "''${R2_EXPLORER_BASE_URL:-}" ]]; then
        fail "R2_EXPLORER_BASE_URL is required for worker share commands."
      fi
      if [[ -z "''${R2_EXPLORER_ADMIN_KID:-}" ]]; then
        fail "R2_EXPLORER_ADMIN_KID is required for worker share commands."
      fi
      if [[ -z "''${R2_EXPLORER_ADMIN_SECRET:-}" ]]; then
        fail "R2_EXPLORER_ADMIN_SECRET is required for worker share commands."
      fi
    }

    uri_escape() {
      local value="''${1:-}"
      jq -nr --arg value "$value" '$value|@uri'
    }

    sha256_hex() {
      local payload="''${1:-}"
      printf '%s' "$payload" | openssl dgst -sha256 | awk '{print $2}'
    }

    hmac_sha256_hex() {
      local secret="''${1:-}"
      local payload="''${2:-}"
      printf '%s' "$payload" | openssl dgst -sha256 -hmac "$secret" | awk '{print $2}'
    }

    worker_sign_request() {
      local method="''${1:-}"
      local path="''${2:-}"
      local query="''${3:-}"
      local body="''${4:-}"
      local ts nonce body_hash canonical signature

      ts="$(date +%s)"
      nonce="$(openssl rand -hex 16)"
      body_hash="$(sha256_hex "$body")"
      canonical="$(printf '%s\n%s\n%s\n%s\n%s\n%s' "$method" "$path" "$query" "$body_hash" "$ts" "$nonce")"
      signature="$(hmac_sha256_hex "$R2_EXPLORER_ADMIN_SECRET" "$canonical")"
      printf '%s|%s|%s\n' "$ts" "$nonce" "$signature"
    }

    worker_api_json() {
      local method="''${1:-}"
      local path="''${2:-}"
      local query="''${3:-}"
      local body="''${4:-}"
      local signed ts nonce signature url response status payload

      ensure_worker_share_env

      signed="$(worker_sign_request "$method" "$path" "$query" "$body")"
      ts="''${signed%%|*}"
      signed="''${signed#*|}"
      nonce="''${signed%%|*}"
      signature="''${signed#*|}"

      url="''${R2_EXPLORER_BASE_URL%/}$path"
      if [[ -n "$query" ]]; then
        url="$url?$query"
      fi

      if [[ -n "$body" ]]; then
        response="$(
          curl -sS \
            -X "$method" \
            -H "content-type: application/json" \
            -H "x-r2e-kid: $R2_EXPLORER_ADMIN_KID" \
            -H "x-r2e-ts: $ts" \
            -H "x-r2e-nonce: $nonce" \
            -H "x-r2e-signature: $signature" \
            --data "$body" \
            --max-time 60 \
            --connect-timeout 10 \
            "$url" \
            -w '\n%{http_code}'
        )"
      else
        response="$(
          curl -sS \
            -X "$method" \
            -H "x-r2e-kid: $R2_EXPLORER_ADMIN_KID" \
            -H "x-r2e-ts: $ts" \
            -H "x-r2e-nonce: $nonce" \
            -H "x-r2e-signature: $signature" \
            --max-time 60 \
            --connect-timeout 10 \
            "$url" \
            -w '\n%{http_code}'
        )"
      fi

      status="''${response##*$'\n'}"
      payload="''${response%$'\n'*}"

      if [[ ! "$status" =~ ^2 ]]; then
        if [[ -n "$payload" ]]; then
          echo "$payload" >&2
        fi
        fail "worker API request failed: $method $path (HTTP $status)"
      fi

      if [[ -n "$payload" ]]; then
        echo "$payload"
      else
        echo '{}'
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

      printf '%s\n' \
        "{\"rules\":[{\"id\":\"trash-cleanup\",\"prefix\":\".trash/\",\"expiration\":{\"days\":$days}}]}" \
        > "$rules_file"

      wrangler r2 bucket lifecycle set "$name" --file "$rules_file"
      echo "Set .trash/ retention to $days days for bucket: $name"
    }

    run_share_presigned() {
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

    run_share_worker_create() {
      local bucket key ttl max_downloads body response next

      [[ "$#" -ge 2 ]] || fail "usage: r2 share worker create <bucket> <key> [ttl] [--max-downloads N]"
      bucket="$1"
      key="$2"
      shift 2

      ttl="24h"
      max_downloads="0"

      if [[ "$#" -gt 0 && ! "''${1:-}" =~ ^-- ]]; then
        ttl="$1"
        shift
      fi

      while [[ "$#" -gt 0 ]]; do
        next="$1"
        shift
        case "$next" in
          --max-downloads)
            [[ "$#" -gt 0 ]] || fail "--max-downloads requires a numeric value"
            max_downloads="$1"
            shift
            ;;
          *)
            fail "unknown option for share worker create: $next"
            ;;
        esac
      done

      [[ "$max_downloads" =~ ^[0-9]+$ ]] || fail "--max-downloads must be a non-negative integer"

      body="$(jq -n \
        --arg bucket "$bucket" \
        --arg key "$key" \
        --arg ttl "$ttl" \
        --argjson max "$max_downloads" \
        '{bucket: $bucket, key: $key, ttl: $ttl, maxDownloads: $max}')"
      response="$(worker_api_json "POST" "/api/share/create" "" "$body")"
      echo "$response" | jq '.'
    }

    run_share_worker_revoke() {
      local token_id body response

      token_id="''${1:-}"
      [[ -n "$token_id" ]] || fail "usage: r2 share worker revoke <token-id>"

      body="$(jq -n --arg tokenId "$token_id" '{tokenId: $tokenId}')"
      response="$(worker_api_json "POST" "/api/share/revoke" "" "$body")"
      echo "$response" | jq '.'
    }

    run_share_worker_list() {
      local bucket key query response

      bucket="''${1:-}"
      key="''${2:-}"
      [[ -n "$bucket" && -n "$key" ]] || fail "usage: r2 share worker list <bucket> <key>"

      query="bucket=$(uri_escape "$bucket")&key=$(uri_escape "$key")"
      response="$(worker_api_json "GET" "/api/share/list" "$query" "")"
      echo "$response" | jq '.'
    }

    run_share_worker() {
      local subcommand="''${1:-help}"
      if [[ "''${subcommand}" =~ ^(-h|--help|help)$ ]]; then
        usage_share_worker
        return
      fi

      shift || true

      case "$subcommand" in
        create)
          run_share_worker_create "$@"
          ;;
        revoke)
          [[ "$#" -eq 1 ]] || fail "usage: r2 share worker revoke <token-id>"
          run_share_worker_revoke "$1"
          ;;
        list)
          [[ "$#" -eq 2 ]] || fail "usage: r2 share worker list <bucket> <key>"
          run_share_worker_list "$1" "$2"
          ;;
        *)
          fail "unknown share worker subcommand '$subcommand'"
          ;;
      esac
    }

    run_share() {
      if [[ "''${1:-}" == "worker" ]]; then
        shift
        run_share_worker "$@"
        return
      fi

      if [[ "''${1:-}" =~ ^(-h|--help|help)$ ]]; then
        usage_share
        return
      fi

      [[ "$#" -ge 2 && "$#" -le 3 ]] || fail "usage: r2 share <bucket> <key> [expiry]"
      run_share_presigned "$@"
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
        run_share "$@"
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
