# Phase 8.2-8.6 Runtime Enablement and Validation Plan (Execution)

## Status

- `8.1` is complete as of **2026-02-14**.
- This document is the execution plan for the remaining Phase 8 milestones:
  `8.2` through `8.6`.

## Cloudflare Real-Domain Snapshot (2026-02-14)

Investigation against the live Cloudflare account and authenticated `wrangler`
CLI confirms:

1. Zone `unsigned.sh` is active.
2. Worker services `r2-explorer` and `r2-explorer-preview` exist.
3. Current Worker bucket bindings still point to:
   - production `FILES_BUCKET`: `nix-r2-cf-r2e-files-prod`
   - preview `FILES_BUCKET`: `nix-r2-cf-r2e-files-preview`
4. Production runtime buckets to use for host services are:
   - sync/files (prod): `nix-r2-cf-r2e-files-prod`
   - sync/files (preview Worker): `nix-r2-cf-r2e-files-preview`
   - restic backups (prod): `nix-r2-cf-backups-prod`
5. Worker custom domain `files.unsigned.sh` is attached to `r2-explorer`
   (`wrangler triggers deploy` route with `custom_domain = true`).
6. DNS for `files.unsigned.sh` now resolves to Cloudflare edge A records.
7. Live host checks succeed for protection boundaries:
   - `GET /api/server/info` unauthenticated returns `401 access_required`.
   - `GET /share/<invalid-token>` returns Worker `404` (public route path reached).

Implication:

- This plan uses `https://files.unsigned.sh` as the production Worker host.
- Runtime services use the production buckets above.
- Cloudflare domain/bucket preconditions for Gate `G` are now satisfied.

## Production Blocker Register (2026-02-14)

| ID     | Blocker                                                                                                    | Status                              | Evidence                                                                                                                              | Action                                                                          |
| ------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `B-01` | `files.unsigned.sh` unresolved                                                                             | closed                              | `wrangler triggers deploy` attached custom domain; `dig` now returns A records                                                        | keep `routes.custom_domain` config under change control                         |
| `B-02` | `/run/secrets/r2/credentials.env` rendered as literal `{{ ... }}` placeholders in `~/nixos`                | fixed in source, activation pending | fixed in `~/nixos/modules/security/r2-cloud-secrets.nix` by switching to `config.sops.placeholder.*`                                  | run `sudo nixos-rebuild switch --flake ~/nixos#system76` before Gate `F`        |
| `B-03` | runtime options still disabled in `~/nixos`                                                                | open                                | `nix eval ...services.r2-sync.enable` / `...r2-restic.enable` / `...git-annex-r2.enable` / HM `...r2-cloud.enable` all return `false` | execute Gates `B`-`D` exactly as written                                        |
| `B-04` | Worker admin signing env for `r2 share worker create` not yet proven on host                               | open                                | no declarative `R2_EXPLORER_ADMIN_*` wiring found in `~/nixos` modules/secrets                                                        | add host secret/env wiring before Gate `G`                                      |
| `B-05` | `r2-sync` mount/bisync units fail in real-user mode (FUSE hardening + bisync flags/trash/workdir defaults) | fixed in producer                   | observed: `fusermount ... Operation not permitted`, `--max-delete=50%` parse error, bisync trash overlap constraints                  | update `r2-flake` lock to a rev containing the `r2-sync` fixes; re-run Gate `B` |

## Summary

Remaining Phase 8 work is operationally coupled:

1. enable services in safe stages (`8.2`),
2. verify host runtime behavior (`8.3`),
3. validate live remote connectivity (`8.4`),
4. validate sharing user journeys (`8.5`),
5. close with evidence and docs feedback (`8.6`).

Because each milestone depends on the previous one, this plan groups `8.2` to
`8.6` into a single gate-driven execution sequence.

## Critical Review Of Current Matrix

The matrix in `docs/plan.md` is correct but intentionally high-level. For
execution, these gaps need explicit handling:

1. **No stage-level rollback criteria** are defined for `switch` failures or
   partially healthy services.
2. **No required evidence format** is defined, which makes acceptance difficult
   to verify consistently.
3. **No preflight input checklist** exists for values that must be known before
   runtime tests (host, user, mount names, backup bucket, test object key).
4. **Runtime vs remote failures are not separated**, which can blur triage
   (systemd wiring issue vs R2/Auth issue).

This plan resolves those gaps by adding gates, fail criteria, rollback rules,
and an evidence template.

## Milestone Mapping

| Milestone                            | Execution gates in this plan | Completion signal                                                               |
| ------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------- |
| `8.2` Staged service enablement      | Gates `B` through `D`        | `nixos-rebuild switch` succeeds for each stage and no manual patching is needed |
| `8.3` Runtime service verification   | Gate `E`                     | Units/timers/commands are active/invokable from managed config                  |
| `8.4` Remote connectivity validation | Gate `F`                     | `rclone` listing and `restic snapshots` succeed with runtime secrets            |
| `8.5` Sharing UX validation          | Gate `G`                     | Presigned and Worker links behave correctly; `/api/*` remains Access-protected  |
| `8.6` Acceptance + feedback loop     | Gate `H`                     | Evidence and doc updates are merged into planning and operator/user docs        |

## Scope Boundaries

### In scope (`8.2`-`8.6`)

- Consumer-side runtime enablement in `~/nixos` for host `system76`.
- Staged service rollout for:
  - `services.r2-sync`
  - `services.r2-restic`
  - `programs.git-annex-r2`
  - `programs.r2-cloud` (HM wrapper)
- Host runtime and timer verification.
- Live remote checkpoints for R2 + restic.
- End-to-end sharing checkpoints from managed host.
- Documentation feedback updates based on observed friction.

### Out of scope

- New producer feature work in `nix-R2-CloudFlare-Flake` unless a blocking bug
  is discovered during runtime validation.
- CI/workflow redesign (Phase 7 area).
- New architecture changes outside current Phase 8 acceptance criteria.

## Resolved Execution Values (2026-02-14)

Use these values directly for Gates `A` through `G`:

| Input                      | Concrete value                                       |
| -------------------------- | ---------------------------------------------------- |
| target host                | `system76`                                           |
| target HM user             | `vx`                                                 |
| sync mount profile name    | `workspace`                                          |
| sync/files bucket          | `nix-r2-cf-r2e-files-prod`                           |
| sync remote prefix         | `workspace`                                          |
| sync local path            | `/data/r2/workspace`                                 |
| sync mount point           | `/data/r2/mount/workspace`                           |
| preview files bucket       | `nix-r2-cf-r2e-files-preview`                        |
| restic bucket              | `nix-r2-cf-backups-prod`                             |
| Worker bucket alias        | `files`                                              |
| test share object key      | `workspace/demo.txt`                                 |
| Worker base URL            | `https://files.unsigned.sh`                          |
| Cloudflare token file      | `/home/vx/nixos/secrets/decrypted_cf_token.txt`      |
| Cloudflare account-id file | `/home/vx/nixos/secrets/decrypted_cf_ACCOUNT_ID.txt` |

## Branch And Change-Control Strategy

Consumer repo only unless blocked:

- Repo: `~/nixos`
- Branch: `phase-8-runtime-validation`
- Worktree: `~/trees/nixos/phase-8-runtime-validation`

Recommended discipline:

1. One commit per gate (`B`, `C`, `D`, and final docs updates).
2. If a gate fails, rollback only the current gate commit and re-run `switch`.
3. Do not apply ad-hoc manual host fixes without corresponding declarative
   config changes.

Concrete file targets in `~/nixos`:

1. Stage config edits in `modules/system76/r2-runtime.nix` (auto-imported by
   `modules/system76/imports.nix`).
2. Record gate evidence in `docs/phase-8-runtime-evidence.md`.

## Gate Sequence

| Gate | Description                                                               | Milestone coverage |
| ---- | ------------------------------------------------------------------------- | ------------------ |
| `A`  | Preflight: baseline checks, required inputs, evidence file initialization | setup              |
| `B`  | Stage 1 enablement: `services.r2-sync` only                               | `8.2`              |
| `C`  | Stage 2 enablement: add `services.r2-restic`                              | `8.2`              |
| `D`  | Stage 3 enablement: add `programs.git-annex-r2` + HM `programs.r2-cloud`  | `8.2`              |
| `E`  | Consolidated runtime verification (units/timers/CLI)                      | `8.3`              |
| `F`  | Live remote connectivity checks (`rclone`, `restic`)                      | `8.4`              |
| `G`  | Sharing UX validation (presigned + Worker mode + Access split)            | `8.5`              |
| `H`  | Acceptance recording + documentation feedback updates                     | `8.6`              |

## Detailed Execution Plan

### Gate A: Preflight And Baseline

Run from `~/nixos` worktree and keep one shell session for exported variables:

```bash
set -euo pipefail

export CF_TOKEN_FILE="/home/vx/nixos/secrets/decrypted_cf_token.txt"
export CF_ACCOUNT_ID_FILE="/home/vx/nixos/secrets/decrypted_cf_ACCOUNT_ID.txt"
export CF_API_TOKEN="$(tr -d '\n' < "$CF_TOKEN_FILE")"
export CF_ACCOUNT_ID="$(tr -d '\n' < "$CF_ACCOUNT_ID_FILE")"

export R2_HOST="system76"
export R2_HM_USER="vx"
export R2_MOUNT_NAME="workspace"
export R2_SYNC_BUCKET="nix-r2-cf-r2e-files-prod"
export R2_PREVIEW_BUCKET="nix-r2-cf-r2e-files-preview"
export R2_RESTIC_BUCKET="nix-r2-cf-backups-prod"
export R2_WORKER_BUCKET_ALIAS="files"
export R2_SHARE_OBJECT_KEY="workspace/demo.txt"
export R2_WORKER_BASE_URL="https://files.unsigned.sh"

nix eval --raw ~/nixos#nixosConfigurations.system76.config.networking.hostName
nix eval --raw ~/nixos#lib.meta.owner.username
nix eval --json ~/nixos#nixosConfigurations.system76.config.services.r2-sync.enable
nix eval --json ~/nixos#nixosConfigurations.system76.config.services.r2-restic.enable
nix eval --json ~/nixos#nixosConfigurations.system76.config.programs.git-annex-r2.enable
nix eval --json ~/nixos#nixosConfigurations.system76.config.home-manager.users.vx.programs.r2-cloud.enable

nix flake check
sudo nixos-rebuild dry-activate --flake ~/nixos#system76
test -f /run/secrets/r2/account-id
test -f /run/secrets/r2/credentials.env
test -f /run/secrets/r2/restic-password
```

Capture baseline:

```bash
systemctl list-units 'r2-*' --all
systemctl list-timers 'r2-*' --all
```

Ensure dedicated buckets exist (create only if missing):

```bash
for bucket in "$R2_SYNC_BUCKET" "$R2_PREVIEW_BUCKET" "$R2_RESTIC_BUCKET"; do
  if ! CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" \
      nix run nixpkgs#wrangler -- r2 bucket list | rg -q "name:\\s+${bucket}$"; then
    CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" \
      nix run nixpkgs#wrangler -- r2 bucket create "$bucket"
  fi
done
```

Cloudflare real-domain readiness (required before Gate `G`):

1. Verify current Worker bucket binding state:

```bash
R2E_PROD_VERSION_ID="$(
  CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" \
    nix run nixpkgs#wrangler -- deployments status --name r2-explorer \
    | awk '/Version\\(s\\):/ { print $NF }'
)"

CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" \
  nix run nixpkgs#wrangler -- versions view "$R2E_PROD_VERSION_ID" --name r2-explorer \
  | rg 'env\.FILES_BUCKET|env\.R2E_BUCKET_MAP|env\.R2E_PUBLIC_BASE_URL'
```

2. Confirm Worker `FILES_BUCKET` remains bound to `nix-r2-cf-r2e-files-prod`
   before share validation.
3. Ensure `r2-explorer` is attached to Worker Custom Domain
   `files.unsigned.sh` (Worker as origin model).
4. Keep Access policy split on host `files.unsigned.sh`:
   - `/*` = Allow trusted identities
   - `/share/*` = Bypass (public token links)
5. Confirm CI/live smoke endpoint uses the real host:
   - production environment secret `R2E_SMOKE_BASE_URL` should be
     `https://files.unsigned.sh`
6. Verify DNS/certificate propagation for the subdomain:

```bash
dig files.unsigned.sh +nocmd +noall +answer +comments
curl -I https://files.unsigned.sh
```

Expected:

- `dig` returns an answer for `files.unsigned.sh` (not SOA-only/NODATA).
- `curl` returns an HTTPS response (Access redirect or Worker response).

Fail Gate `A` if any required secret path is missing, dry-activate fails, or
Cloudflare readiness checks remain unresolved.

### Gate B: Stage 1 Enable `services.r2-sync`

Create or update `~/nixos/modules/system76/r2-runtime.nix` with stage-1 config:

```nix
{ metaOwner, ... }:
{
  configurations.nixos.system76.module =
    { config, lib, ... }:
    let
      inherit (metaOwner) username;
      group = lib.attrByPath [ "users" "users" username "group" ] "users" config;
    in
    {
      programs.fuse.userAllowOther = true;

      services.r2-sync = {
        enable = true;
        credentialsFile = "/run/secrets/r2/credentials.env";
        accountIdFile = "/run/secrets/r2/account-id";

        mounts.workspace = {
          bucket = "nix-r2-cf-r2e-files-prod";
          remotePrefix = "workspace";
          mountPoint = "/data/r2/mount/workspace";
          localPath = "/data/r2/workspace";
          syncInterval = "5m";
        };
      };

      systemd = {
        # Run operational services as the real user so /data/r2/* stays user-owned.
        services = {
          "r2-mount-workspace".serviceConfig = {
            User = username;
            Group = group;
          };
          "r2-bisync-workspace".serviceConfig = {
            User = username;
            Group = group;
          };
        };

        # Ensure paths exist (and are user-owned) before services start.
        tmpfiles.rules = [
          "d /data/r2 0750 ${username} ${group} - -"
          "d /data/r2/.trash 0750 ${username} ${group} - -"
          "d /data/r2/mount 0750 ${username} ${group} - -"
          "d /data/r2/mount/workspace 0750 ${username} ${group} - -"
          "d /data/r2/workspace 0750 ${username} ${group} - -"
        ];
      };
    };
}
```

Apply:

```bash
sudo nixos-rebuild switch --flake ~/nixos#system76
```

Verification:

```bash
systemctl status r2-mount-workspace --no-pager
systemctl status r2-bisync-workspace --no-pager
systemctl status r2-bisync-workspace.timer --no-pager
journalctl -u r2-mount-workspace -n 100 --no-pager
journalctl -u r2-bisync-workspace -n 100 --no-pager
```

Fail Gate `B` if mount service does not stabilize or timer is absent.

### Gate C: Stage 2 Add `services.r2-restic`

Extend `~/nixos/modules/system76/r2-runtime.nix` by adding restic:

```nix
services.r2-restic = {
  enable = true;
  credentialsFile = "/run/secrets/r2/credentials.env";
  accountIdFile = "/run/secrets/r2/account-id";
  passwordFile = "/run/secrets/r2/restic-password";
  bucket = "nix-r2-cf-backups-prod";
  paths = [ "/data/r2/workspace" ];
};
```

Also run the backup unit as the real user (to avoid root-owned files under
`/data/r2/*`):

```nix
systemd.services."r2-restic-backup".serviceConfig = {
  User = username;
  Group = group;
};
```

Apply and verify:

```bash
sudo nixos-rebuild switch --flake ~/nixos#system76
systemctl status r2-restic-backup.service --no-pager
systemctl status r2-restic-backup.timer --no-pager
journalctl -u r2-restic-backup.service -n 100 --no-pager
```

Optional controlled invocation:

```bash
sudo systemctl start r2-restic-backup.service
sudo systemctl status r2-restic-backup.service --no-pager
```

Fail Gate `C` if service/timer units are missing or oneshot runs fail.

### Gate D: Stage 3 Add `git-annex` + `r2` Wrapper

Extend `~/nixos/modules/system76/r2-runtime.nix` with system and HM CLI
surfaces:

```nix
programs.git-annex-r2 = {
  enable = true;
  credentialsFile = "/run/secrets/r2/credentials.env";
  defaultBucket = "nix-r2-cf-r2e-files-prod";
  defaultPrefix = "annex/system76";
};
```

```nix
home-manager.users.vx.programs.r2-cloud = {
  enable = true;
  accountIdFile = "/run/secrets/r2/account-id";
  credentialsFile = "/run/secrets/r2/credentials.env";
};
```

Apply and verify:

```bash
sudo nixos-rebuild switch --flake ~/nixos#system76
command -v git-annex-r2-init
command -v r2
test -r /run/secrets/r2/credentials.env
```

Fail Gate `D` if either command is unavailable after switch.

### Gate E: Milestone `8.3` Runtime Verification

Consolidated runtime checks:

```bash
systemctl list-units 'r2-mount-*' --all
systemctl list-units 'r2-bisync-*' --all
systemctl list-units 'r2-restic-backup*' --all
systemctl list-timers 'r2-*' --all
sudo systemctl start r2-bisync-workspace.service
sudo systemctl start r2-restic-backup.service
```

Acceptance:

- mount unit(s) active (or expected state for configuration)
- bisync timer present and next run scheduled
- restic timer present and invokable
- `git-annex-r2-init` and `r2` resolve in expected PATH context

### Gate F: Milestone `8.4` Remote Connectivity Validation

Use runtime secrets only (system-scoped):

```bash
bash -lc '
set -euo pipefail
set -a
source /run/secrets/r2/credentials.env
set +a

rclone lsf :s3:nix-r2-cf-r2e-files-prod \
  --config=/dev/null \
  --s3-provider=Cloudflare \
  --s3-endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --s3-env-auth

export RESTIC_PASSWORD_FILE=/run/secrets/r2/restic-password
restic -r "s3:https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/nix-r2-cf-backups-prod" snapshots
'
```

Acceptance:

- `rclone lsf` returns expected listing and does not fail auth/signature checks
- `restic snapshots` succeeds without repository/auth errors

### Gate G: Milestone `8.5` Sharing UX Validation

Presigned and Worker checks:

```bash
r2 share "$R2_SYNC_BUCKET" "$R2_SHARE_OBJECT_KEY" 24h

share_json="$(r2 share worker create "$R2_WORKER_BUCKET_ALIAS" "$R2_SHARE_OBJECT_KEY" 24h --max-downloads 1)"
printf '%s\n' "${share_json}"
share_url="$(printf '%s' "${share_json}" | jq -r '.url')"
r2 share worker list "$R2_WORKER_BUCKET_ALIAS" "$R2_SHARE_OBJECT_KEY"
curl -I "${share_url}"
curl -I https://files.unsigned.sh/api/list
```

Acceptance:

- presigned command returns a valid S3 URL
- Worker create/list succeed with admin auth env
- `GET /share/<token>` works for valid token
- `GET /api/list` remains Access-protected (`302` or `401`, not public `200`)

### Gate H: Milestone `8.6` Acceptance And Feedback Loop

Required updates after successful gates:

1. Update `docs/plan.md`:
   - mark `8.2` to `8.6` complete with dated evidence notes.
2. Update user/operator docs based on observed friction:
   - `docs/quickstart.md`
   - `docs/sharing.md`
   - `docs/troubleshooting.md`
   - `docs/operators/*` (if operational changes were required)
3. Record unresolved issues (if any) with explicit next owner/action.

## Failure Signatures And Triage Rules

Use these rules to avoid conflating failure domains:

1. `nixos-rebuild switch` or assertion failure:
   - stop at current gate,
   - fix declarative config first,
   - re-run same gate.
2. systemd unit/timer missing:
   - module not enabled or config path mismatch in `~/nixos`.
3. auth/signature failures in `rclone` or `restic`:
   - verify `/run/secrets/r2/credentials.env` values and account-id source.
4. Worker admin `401`/`403`:
   - verify `R2_EXPLORER_BASE_URL`, `R2_EXPLORER_ADMIN_KID`,
     `R2_EXPLORER_ADMIN_SECRET`.
5. `/api/list` returns unauthenticated `200`:
   - Access policy split or Worker Access JWT guard regression.

## Evidence Template

Use one markdown evidence file in `~/nixos` branch (example:
`docs/phase-8-runtime-evidence.md`) with this structure:

```markdown
# Phase 8 Runtime Evidence

## Gate A

- command:
- result:
- artifacts/logs:

## Gate B

- switch command:
- service/timer checks:
- failures and fixes:

## Gate C

- switch command:
- restic unit/timer checks:
- failures and fixes:

## Gate D

- switch command:
- CLI path checks:
- failures and fixes:

## Gate E

- runtime verification checklist:

## Gate F

- rclone listing output summary:
- restic snapshots output summary:

## Gate G

- presigned URL check:
- worker create/list check:
- access-protection check:

## Gate H

- docs updated:
- unresolved items:
```

## Final Acceptance Criteria For Phase 8 Closure

Phase 8 can be marked complete only when:

1. Gates `A` through `H` are complete and documented.
2. `docs/plan.md` marks milestones `8.2` to `8.6` as `[x]` with dated evidence.
3. Quickstart/runbook/troubleshooting updates are committed for any observed
   first-user friction.
