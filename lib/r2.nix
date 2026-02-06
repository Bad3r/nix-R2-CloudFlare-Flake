{ lib }:
{
  mkR2Endpoint = accountId: "https://${accountId}.r2.cloudflarestorage.com";

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
