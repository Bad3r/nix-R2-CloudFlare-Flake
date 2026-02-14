# Quickstart

This guide covers template-based bootstrap for sync-only and full setups:

- `templates/minimal` -> sync-only NixOS setup
- `templates/full` -> sync + restic + git-annex + Home Manager CLI

For full option semantics and assertion behavior, see `docs/reference/index.md`.
Run template-specific commands only; do not mix `minimal` and `full` checks in
the same generated project.

## 1. Create a new project from a template

Set your template source once:

```bash
# Local checkout source (recommended while developing this repo)
export TEMPLATE_SOURCE="$(pwd)"

# Or use the remote source
# export TEMPLATE_SOURCE="github:Bad3r/nix-R2-CloudFlare-Flake?ref=main"
```

Create the project:

```bash
mkdir -p ~/tmp/r2-minimal
cd ~/tmp/r2-minimal
nix flake init -t "${TEMPLATE_SOURCE}#minimal"
```

Or full setup:

```bash
mkdir -p ~/tmp/r2-full
cd ~/tmp/r2-full
nix flake init -t "${TEMPLATE_SOURCE}#full"
```

## 2. Configure required values

Template values to replace before deployment:

- `secrets/r2.yaml` content (account ID, keys, restic password)
- SOPS policy to include `secrets/r2.yaml` and template output

## 3. Evaluate and smoke-test template output

Run in the generated directory:

```bash
nix flake show
nix flake check
```

Expected result:

- `nix flake check` completes without editing template structure

## 4. Evaluate activation (no runtime changes)

Minimal template:

```bash
sudo nixos-rebuild dry-activate --flake .#r2-minimal
```

Full template:

```bash
sudo nixos-rebuild dry-activate --flake .#r2-full
```

Expected result:

- no module assertion failures for `services.r2-sync`, `services.r2-restic`, or `programs.git-annex-r2`

## 5. Apply runtime configuration (required for service status checks)

Minimal template:

```bash
sudo nixos-rebuild switch --flake .#r2-minimal
```

Full template:

```bash
sudo nixos-rebuild switch --flake .#r2-full
```

Expected result:

- system activation succeeds without assertion errors

## 6. Verify service wiring (minimal path)

Run these checks only for the minimal template:

```bash
sudo systemctl status r2-mount-documents
sudo systemctl status r2-bisync-documents
sudo systemctl list-timers | grep r2-bisync-documents
```

Expected result:

- `r2-mount-documents` is active
- `r2-bisync-documents` service is invokable
- `r2-bisync-documents.timer` is scheduled

Minimal remote checkpoint:

```bash
set -a
source /run/secrets/r2/credentials.env
set +a

rclone lsf :s3:documents \
  --config=/dev/null \
  --s3-provider=Cloudflare \
  --s3-endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --s3-env-auth
```

Expected result:

- local units are active/scheduled as listed above
- remote `documents` bucket listing succeeds without authentication errors

## 7. Verify service wiring (full path)

Run these checks only for the full template:

```bash
sudo systemctl status r2-mount-workspace
sudo systemctl status r2-bisync-workspace
sudo systemctl list-timers | grep r2-bisync-workspace
sudo systemctl status r2-restic-backup
sudo systemctl list-timers | grep r2-restic-backup
command -v git-annex-r2-init
command -v r2
```

Expected result:

- `r2-mount-workspace` is active
- bisync and restic timers/services are present and invokable
- `git-annex-r2-init` and `r2` are available in PATH

Full remote checkpoints:

```bash
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
```

Expected result:

- local units and CLI helpers are present as listed above
- remote `files` listing succeeds
- restic repository snapshot listing succeeds without auth/repository errors

## 8. Sharing checkpoint (full path)

Prerequisite: R2-Explorer is deployed and Worker admin environment variables are available.

```bash
r2 share nix-r2-cf-r2e-files-prod workspace/demo.txt 24h
share_json="$(r2 share worker create files workspace/demo.txt 24h --max-downloads 1)"
echo "${share_json}"
share_url="$(printf '%s' "${share_json}" | jq -r '.url')"
r2 share worker list files workspace/demo.txt
curl -I "${share_url}"
curl -I https://files.unsigned.sh/api/list
```

Expected result:

- presigned command returns an R2 S3 URL
- worker create returns a `url` on your custom domain
- worker list includes the created token record
- `GET <url>` returns object response headers for a valid token
- `GET /api/list` remains Cloudflare-Access protected (not public)

For Access policy and Worker token behavior details, continue in `docs/sharing.md`.
For failure diagnosis across sync/backup/share/auth flows, use
`docs/troubleshooting.md`.

## 9. Contract map (template -> command -> expected unit)

| Template | Config Path                                      | Verification Command                                | Expected Unit/Effect       |
| -------- | ------------------------------------------------ | --------------------------------------------------- | -------------------------- |
| minimal  | `services.r2-sync.mounts.documents`              | `systemctl status r2-mount-documents`               | mount service exists       |
| minimal  | `services.r2-sync.mounts.documents.syncInterval` | `systemctl list-timers \| grep r2-bisync-documents` | bisync timer exists        |
| full     | `services.r2-sync.mounts.workspace`              | `systemctl status r2-mount-workspace`               | mount service exists       |
| full     | `services.r2-restic.bucket`                      | `systemctl status r2-restic-backup`                 | restic oneshot unit exists |
| full     | `programs.git-annex-r2.*`                        | `command -v git-annex-r2-init`                      | helper is installed        |
| full     | `programs.r2-cloud.enable`                       | `command -v r2`                                     | wrapper CLI is installed   |
