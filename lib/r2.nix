{ lib, ... }:
{
  mkR2Endpoint = accountId: "https://${accountId}.r2.cloudflarestorage.com";

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
      elif [[ -n "$account_id_file" && -r "$account_id_file" ]]; then
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
    name:
    let
      isValid = builtins.match "^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$" name != null;
    in
    if isValid then name else throw "Invalid R2 bucket name: ${name}";

  # Placeholder for future shared option constructors.
  mkPlaceholder = message: {
    _type = "r2-placeholder";
    inherit message;
  };
}
