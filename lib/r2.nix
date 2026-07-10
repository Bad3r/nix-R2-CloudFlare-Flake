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
}
