{ lib, ... }:
let
  asNonEmptyString =
    value:
    if value == null then
      null
    else
      let
        rendered = toString value;
      in
      if rendered == "" then null else rendered;

  firstNonEmpty =
    values:
    let
      present = builtins.filter (value: value != null) (builtins.map asNonEmptyString values);
    in
    if present == [ ] then null else builtins.head present;

  shortToken =
    length: token:
    if builtins.stringLength token <= length then token else builtins.substring 0 length token;

  sanitizeToken =
    token:
    let
      withoutPrefix = lib.removePrefix "sha256-" token;
    in
    builtins.replaceStrings [ "/" "+" "=" ] [ "-" "-" "" ] withoutPrefix;

  mkSrcToken =
    src:
    let
      storePath = builtins.path {
        path = src;
        name = "r2-source";
      };
      baseName = builtins.baseNameOf (toString storePath);
      matches = builtins.match "^([0-9a-z]{32})-.*$" baseName;
      hashPrefix =
        if matches == null then
          builtins.hashString "sha256" (toString storePath)
        else
          builtins.elemAt matches 0;
    in
    shortToken 12 hashPrefix;

  getSourceField =
    sourceInfo: field:
    if sourceInfo != null && builtins.hasAttr field sourceInfo then sourceInfo.${field} else null;
in
{
  releaseBase = "0.1.0";

  mkDerivationVersion =
    {
      releaseBase ? "0.1.0",
      sourceInfo ? null,
      rev ? null,
      shortRev ? null,
      dirtyRev ? null,
      dirtyShortRev ? null,
      src ? null,
    }:
    let
      revRaw = firstNonEmpty [
        dirtyShortRev
        (getSourceField sourceInfo "dirtyShortRev")
        shortRev
        (getSourceField sourceInfo "shortRev")
        dirtyRev
        (getSourceField sourceInfo "dirtyRev")
        rev
        (getSourceField sourceInfo "rev")
      ];
      revToken = if revRaw == null then null else shortToken 16 (sanitizeToken revRaw);
      srcToken = if src == null then "nosource" else mkSrcToken src;
    in
    if revToken != null then "${releaseBase}+git.${revToken}" else "${releaseBase}+src.${srcToken}";
}
