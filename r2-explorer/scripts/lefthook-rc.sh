#!/bin/sh
# Bridge work when hooks are invoked from the r2-explorer subdirectory.
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# shellcheck source=/dev/null
. "$repo_root/scripts/lefthook-rc.sh"
