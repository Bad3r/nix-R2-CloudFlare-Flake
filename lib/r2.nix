{ lib, ... }:
let
  isValidBucketName = name: builtins.match "^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$" name != null;
in
{
  inherit isValidBucketName;

  mkR2Endpoint = accountId: "https://${accountId}.r2.cloudflarestorage.com";

  # Collapse an R2 object prefix to canonical "seg1/seg2" form. Leading,
  # trailing, and repeated slashes are removed, so values like "/", "//",
  # or "workspace/" cannot silently move a sync root (or its trash
  # backup-dir) to the bucket root.
  normalizeRemotePrefix =
    prefix:
    let
      segments = builtins.filter (segment: builtins.isString segment && segment != "") (
        builtins.split "/" prefix
      );
    in
    lib.concatStringsSep "/" segments;

  mkResolveAccountIdShell =
    {
      literalAccountId,
      accountIdFile,
      envVar ? "R2_ACCOUNT_ID",
      outputVar ? "R2_RESOLVED_ACCOUNT_ID",
    }:
    let
      literal = lib.escapeShellArg literalAccountId;
      file = lib.escapeShellArg (if accountIdFile == null then "" else toString accountIdFile);
    in
    ''
      ${outputVar}=""
      literal_account_id=${literal}
      account_id_file=${file}

      if [[ -n "$literal_account_id" ]]; then
        ${outputVar}="$literal_account_id"
      elif [[ -n "$account_id_file" ]]; then
        # A configured account ID file must be readable; falling back to the
        # environment here would mask a misconfigured secret path.
        if [[ ! -r "$account_id_file" ]]; then
          echo "Error: account ID file is missing or unreadable: $account_id_file" >&2
          exit 1
        fi
        { IFS= read -r ${outputVar} || true; } < "$account_id_file"
      else
        ${outputVar}="''${${envVar}:-}"
      fi

      _trim_val="''${${outputVar}:-}"
      _trim_val="''${_trim_val#"''${_trim_val%%[!$' \t\r\n']*}"}"
      _trim_val="''${_trim_val%"''${_trim_val##*[!$' \t\r\n']}"}"
      ${outputVar}="$_trim_val"

      if [[ -z "''${${outputVar}:-}" ]]; then
        echo "Error: unable to resolve account ID (literal, file, or ${envVar})" >&2
        exit 1
      fi
    '';

  validateBucketName =
    name: if isValidBucketName name then name else throw "Invalid R2 bucket name: ${name}";

  # r2_source_env_file <path>: exports KEY=VALUE pairs as data, never through
  # `source`/`eval`. Errors name file and line, not content (may be a secret).
  sourceEnvFileShellFunction = ''
    r2_source_env_file() {
      local env_file="$1"
      local line_no=0
      local line key raw_value trimmed_value value

      while IFS= read -r line || [[ -n "$line" ]]; do
        line_no=$((line_no + 1))
        line="''${line%$'\r'}"

        if [[ "$line" =~ ^[[:space:]]*(#|$) ]]; then
          continue
        fi

        if [[ "$line" =~ ^(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
          key="''${BASH_REMATCH[2]}"
          raw_value="''${BASH_REMATCH[3]}"
        else
          echo "Error: $env_file: line $line_no: expected KEY=VALUE" >&2
          exit 1
        fi

        trimmed_value="''${raw_value#"''${raw_value%%[!$' \t\r\n']*}"}"
        trimmed_value="''${trimmed_value%"''${trimmed_value##*[!$' \t\r\n']}"}"

        if [[ ''${#trimmed_value} -ge 2 && ''${trimmed_value:0:1} == '"' && ''${trimmed_value: -1} == '"' ]]; then
          value="''${trimmed_value:1:-1}"
        elif [[ ''${#trimmed_value} -ge 2 && ''${trimmed_value:0:1} == "'" && ''${trimmed_value: -1} == "'" ]]; then
          value="''${trimmed_value:1:-1}"
        else
          value="$trimmed_value"
        fi

        export "$key=$value"
      done < "$env_file"
    }
  '';
}
