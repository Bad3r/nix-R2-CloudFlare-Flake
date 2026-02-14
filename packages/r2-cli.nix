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
    worker_admin_secret_hex=""

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
        "  lifecycle <subcommand> ...  Manage bucket lifecycle rules" \
        "  help                  Show this help"
    }

    usage_bucket_lifecycle() {
      printf '%s\n' \
        "Usage:" \
        "  r2 bucket lifecycle list <bucket>" \
        "  r2 bucket lifecycle add <bucket> <rule-id> <prefix> [--expire-days N] [--ia-transition-days N] [--abort-multipart-days N]" \
        "  r2 bucket lifecycle remove <bucket> <rule-id>" \
        "  r2 bucket lifecycle <bucket> [days]   # legacy alias for trash-cleanup" \
        "" \
        "Notes:" \
        "  - The legacy alias updates rule 'trash-cleanup' for prefix '.trash/' without overwriting full lifecycle config." \
        "  - At least one of --expire-days, --ia-transition-days, or --abort-multipart-days is required for add."
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
        "  R2_EXPLORER_BASE_URL     e.g. https://files.unsigned.sh" \
        "  R2_EXPLORER_ADMIN_KID    key id from R2E_KEYS_KV keyset" \
        "  R2_EXPLORER_ADMIN_SECRET key material (plain text or base64:<value>)"
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
      if [[ -z "$worker_admin_secret_hex" ]]; then
        if ! worker_admin_secret_hex="$(normalize_secret_hex "$R2_EXPLORER_ADMIN_SECRET")"; then
          fail "R2_EXPLORER_ADMIN_SECRET has invalid key material. Use plain text or base64:<value>."
        fi
      fi
    }

    bytes_to_hex() {
      od -An -tx1 -v | tr -d ' \n'
    }

    is_valid_base64_payload() {
      local value="''${1:-}"
      [[ -n "$value" ]] || return 1
      [[ "$value" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || return 1
      (( ''${#value} % 4 == 0 )) || return 1
      return 0
    }

    normalize_secret_hex() {
      local raw="''${1:-}"
      local value key_hex
      if [[ "$raw" == base64:* ]]; then
        value="''${raw#base64:}"
        if ! is_valid_base64_payload "$value"; then
          echo "R2_EXPLORER_ADMIN_SECRET has invalid base64 payload after base64: prefix." >&2
          return 1
        fi
        if ! key_hex="$(printf '%s' "$value" | openssl base64 -d -A 2>/dev/null | bytes_to_hex)"; then
          echo "R2_EXPLORER_ADMIN_SECRET has invalid base64 payload after base64: prefix." >&2
          return 1
        fi
      else
        key_hex="$(printf '%s' "$raw" | bytes_to_hex)"
      fi

      if [[ -z "$key_hex" ]]; then
        echo "R2_EXPLORER_ADMIN_SECRET resolves to empty key material." >&2
        return 1
      fi
      printf '%s\n' "$key_hex"
    }

    uri_escape() {
      local value="''${1:-}"
      jq -nr --arg value "$value" '$value|@uri'
    }

    sha256_hex() {
      local payload="''${1:-}"
      printf '%s' "$payload" | openssl dgst -sha256 | awk '{print $2}'
    }

    hmac_sha256_hex_with_hex_key() {
      local secret_hex="''${1:-}"
      local payload="''${2:-}"
      printf '%s' "$payload" |
        openssl dgst -sha256 -mac HMAC -macopt "hexkey:$secret_hex" |
        awk '{print $2}'
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
      signature="$(hmac_sha256_hex_with_hex_key "$worker_admin_secret_hex" "$canonical")"
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

    require_non_negative_int() {
      local value="''${1:-}"
      local label="''${2:-value}"
      [[ "$value" =~ ^[0-9]+$ ]] || fail "$label must be a non-negative integer (got '$value')."
    }

    run_bucket_lifecycle_list() {
      local bucket="''${1:-}"
      [[ -n "$bucket" ]] || fail "usage: r2 bucket lifecycle list <bucket>"

      load_credentials
      ensure_wrangler
      wrangler r2 bucket lifecycle list "$bucket"
    }

    run_bucket_lifecycle_add() {
      local bucket="''${1:-}"
      local rule_id="''${2:-}"
      local prefix="''${3:-}"
      local expire_days=""
      local ia_transition_days=""
      local abort_multipart_days=""
      local next
      local lifecycle_cmd=()

      [[ -n "$bucket" && -n "$rule_id" ]] || \
        fail "usage: r2 bucket lifecycle add <bucket> <rule-id> <prefix> [--expire-days N] [--ia-transition-days N] [--abort-multipart-days N]"

      shift 3 || true

      while [[ "$#" -gt 0 ]]; do
        next="$1"
        shift
        case "$next" in
          --expire-days)
            [[ "$#" -gt 0 ]] || fail "--expire-days requires a numeric value"
            expire_days="$1"
            shift
            require_non_negative_int "$expire_days" "--expire-days"
            ;;
          --ia-transition-days)
            [[ "$#" -gt 0 ]] || fail "--ia-transition-days requires a numeric value"
            ia_transition_days="$1"
            shift
            require_non_negative_int "$ia_transition_days" "--ia-transition-days"
            ;;
          --abort-multipart-days)
            [[ "$#" -gt 0 ]] || fail "--abort-multipart-days requires a numeric value"
            abort_multipart_days="$1"
            shift
            require_non_negative_int "$abort_multipart_days" "--abort-multipart-days"
            ;;
          *)
            fail "unknown option for bucket lifecycle add: $next"
            ;;
        esac
      done

      if [[ -z "$expire_days" && -z "$ia_transition_days" && -z "$abort_multipart_days" ]]; then
        fail "bucket lifecycle add requires at least one lifecycle option (--expire-days, --ia-transition-days, or --abort-multipart-days)."
      fi

      load_credentials
      ensure_wrangler

      lifecycle_cmd=(wrangler r2 bucket lifecycle add "$bucket" "$rule_id" "$prefix" --force)
      if [[ -n "$expire_days" ]]; then
        lifecycle_cmd+=(--expire-days "$expire_days")
      fi
      if [[ -n "$ia_transition_days" ]]; then
        lifecycle_cmd+=(--ia-transition-days "$ia_transition_days")
      fi
      if [[ -n "$abort_multipart_days" ]]; then
        lifecycle_cmd+=(--abort-multipart-days "$abort_multipart_days")
      fi
      "''${lifecycle_cmd[@]}"
      echo "Updated lifecycle rule '$rule_id' on bucket: $bucket"
    }

    run_bucket_lifecycle_remove() {
      local bucket="''${1:-}"
      local rule_id="''${2:-}"
      [[ -n "$bucket" && -n "$rule_id" ]] || fail "usage: r2 bucket lifecycle remove <bucket> <rule-id>"

      load_credentials
      ensure_wrangler
      wrangler r2 bucket lifecycle remove "$bucket" --name "$rule_id"
      echo "Removed lifecycle rule '$rule_id' from bucket: $bucket"
    }

    run_bucket_lifecycle_legacy_alias() {
      local bucket="''${1:-}"
      local days="''${2:-30}"

      [[ -n "$bucket" ]] || fail "usage: r2 bucket lifecycle <bucket> [days]"
      require_non_negative_int "$days" "retention days"

      echo "Warning: 'r2 bucket lifecycle <bucket> [days]' is deprecated." >&2
      echo "Warning: use 'r2 bucket lifecycle add <bucket> trash-cleanup .trash/ --expire-days <days>' instead." >&2
      run_bucket_lifecycle_add "$bucket" "trash-cleanup" ".trash/" --expire-days "$days"
    }

    run_bucket_lifecycle() {
      local subcommand="''${1:-help}"
      if [[ "''${subcommand}" =~ ^(-h|--help|help)$ ]]; then
        usage_bucket_lifecycle
        return
      fi

      case "$subcommand" in
        list)
          shift || true
          [[ "$#" -eq 1 ]] || fail "usage: r2 bucket lifecycle list <bucket>"
          run_bucket_lifecycle_list "$1"
          ;;
        add)
          shift || true
          [[ "$#" -ge 5 ]] || \
            fail "usage: r2 bucket lifecycle add <bucket> <rule-id> <prefix> [--expire-days N] [--ia-transition-days N] [--abort-multipart-days N]"
          run_bucket_lifecycle_add "$@"
          ;;
        remove)
          shift || true
          [[ "$#" -eq 2 ]] || fail "usage: r2 bucket lifecycle remove <bucket> <rule-id>"
          run_bucket_lifecycle_remove "$1" "$2"
          ;;
        *)
          [[ "$#" -ge 1 && "$#" -le 2 ]] || fail "usage: r2 bucket lifecycle <bucket> [days]"
          run_bucket_lifecycle_legacy_alias "$@"
          ;;
      esac
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
