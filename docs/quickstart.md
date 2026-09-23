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

Values to prepare before integrating the template into a real host (step 5):

- `secrets/r2.yaml` content (account ID, keys, restic password)
- SOPS policy to include `secrets/r2.yaml` and the host's rendered template output

See `docs/credentials.md` for the runtime secret paths these values feed.

## 3. Evaluate and smoke-test template output

Run in the generated directory:

```bash
nix flake show
nix flake check
```

Expected result:

- `nix flake check` completes without editing template structure

## 4. Build the template system (no activation)

> [!WARNING]
> Never run `nixos-rebuild switch`, `boot`, or `test` with
> `--flake .#r2-minimal` or `.#r2-full` on a real machine.
> `nixosConfigurations.r2-minimal` and `nixosConfigurations.r2-full` carry a
> placeholder `fileSystems."/"` (`tmpfs`) and a placeholder
> `boot.loader.grub.devices = [ "nodev" ]` so that `nix flake check` passes in
> an otherwise empty repository, define no users, networking, or hardware, and
> do not wire sops-nix, so `/run/secrets/r2/*` does not exist under them.
> Activating one replaces the machine's real system generation with that
> placeholder; recovery means selecting an older generation in the boot loader
> menu. Step 5 covers running the services on a real host.

Build only, nothing is activated and no `sudo` is needed.

Minimal template:

```bash
nixos-rebuild build --flake .#r2-minimal
```

Full template:

```bash
nixos-rebuild build --flake .#r2-full
```

Expected result:

- no module assertion failures for `services.r2-sync`, `services.r2-restic`, or `programs.git-annex-r2`
- a `result` symlink to the built system closure

Optional: `nixos-rebuild build-vm --flake .#r2-minimal` builds a throwaway VM
that boots the same unit set. No secrets exist inside it, so
`services.r2-sync`/`services.r2-restic` still fail to start; use it only to
inspect unit wiring, not to validate R2 connectivity.

## 5. Integrate into your host configuration

The template's `nixosConfigurations` output exists for evaluation only (step
4). To run the services for real, copy the pieces you need into the flake
that already builds your host:

1. Add the `r2-cloud` input to your host flake:

   ```nix
   inputs.r2-cloud.url = "github:Bad3r/nix-R2-CloudFlare-Flake?ref=main";
   ```

2. Import `r2-cloud.nixosModules.default` into your host's NixOS
   configuration. For the full template's CLI, also add
   `r2-cloud.homeManagerModules.default` to your `home-manager.sharedModules`.
3. Copy the `services.r2-sync`, `services.r2-restic`, and
   `programs.git-annex-r2`/`programs.r2-cloud` blocks from the generated
   template's `flake.nix` into your host configuration, in place of its
   placeholder `fileSystems."/"` and `boot.loader.grub.devices`, which your
   host already defines from its own `hardware-configuration.nix`.
4. Wire the secrets each block expects (`credentialsFile`, `accountIdFile`,
   `passwordFile`) through sops-nix as described in `docs/credentials.md`, so
   `/run/secrets/r2/*` exists on the host before any service starts.
5. Evaluate, then apply, against your real host (replace `<your-host>` with
   its `nixosConfigurations` attribute name):

   ```bash
   sudo nixos-rebuild dry-activate --flake .#<your-host>
   sudo nixos-rebuild switch --flake .#<your-host>
   ```

Expected result:

- system activation succeeds without assertion errors
- the units checked in steps 6 and 7 below appear on `<your-host>`, not on
  the throwaway template project from step 1

### Non-NixOS hosts (Home Manager only)

The `full` template also defines a standalone `homeConfigurations.alice`
output (Home Manager without NixOS) for hosts that only need the `r2` CLI.
Replace the placeholder `username = "alice"` (and the resulting
`home.homeDirectory`) in the generated `flake.nix`, wire the same
`accountIdFile`/`credentialsFile` secrets described above, then activate:

```bash
home-manager switch --flake .#alice
```

If `home-manager` is not already installed, run it without installing first:
`nix run github:nix-community/home-manager -- switch --flake .#alice`.
This path installs `programs.r2-cloud` only; it creates no
`services.r2-sync`/`services.r2-restic` systemd units, so skip steps 6 and 7
and confirm with `command -v r2` instead.

## 6. Verify service wiring (minimal path)

Run these checks on `<your-host>` from step 5, for the minimal template's mount:

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

Run these checks on `<your-host>` from step 5, for the full template's blocks:

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

rclone lsf :s3:files \
  --config=/dev/null \
  --s3-provider=Cloudflare \
  --s3-endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --s3-env-auth

export RESTIC_PASSWORD_FILE=/run/secrets/r2/restic-password
restic -r "s3:https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/backups" snapshots
```

Expected result:

- local units and CLI helpers are present as listed above
- remote `files` listing succeeds
- restic repository snapshot listing succeeds without auth/repository errors

## 8. Sharing checkpoint (full path)

Prerequisite: R2-Explorer is deployed and Worker admin signing inputs are available.
In managed NixOS deployments, this is typically provided via
`/run/secrets/r2/explorer.env` (wired through `programs.r2-cloud.explorerEnvFile`).
Replace `files.example.com` below with your deployment's own domain.

```bash
r2 share files workspace/demo.txt 24h
share_json="$(r2 share worker create files workspace/demo.txt 24h --max-downloads 2)"
echo "${share_json}"
share_url="$(printf '%s' "${share_json}" | jq -r '.url')"
token_id="$(printf '%s' "${share_json}" | jq -r '.tokenId')"
r2 share worker list files workspace/demo.txt
curl -sS -o /dev/null -w '%{http_code}\n' "${share_url}"
curl -sS -o /dev/null -w '%{http_code}\n' https://files.example.com/api/v2/list
# Cleanup: revoke the token now that verification is done.
if ! r2 share worker revoke "${token_id}"; then
  echo "Warning: failed to revoke token ${token_id}; revoke it manually." >&2
fi
```

Expected result:

- presigned command returns an R2 S3 URL
- worker create returns a `url` on your custom domain
- worker list includes the created token record
- `GET <url>` prints status `200` for a valid token
- `GET /api/v2/list` prints a non-`200` status (Cloudflare-Access protected, not public)

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
