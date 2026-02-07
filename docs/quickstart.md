# Quickstart

This guide tracks Phase 6 Group A deliverables:

- `templates/minimal` -> sync-only NixOS setup
- `templates/full` -> sync + restic + git-annex + Home Manager CLI

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

- `replace-with-cloudflare-account-id`
- secret file paths under `/run/secrets/`

## 3. Evaluate and smoke-test template output

Run in the generated directory:

```bash
nix flake show
nix flake check
```

Expected result:

- `nix flake check` completes without editing template structure

## 4. Build and activate

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

## 5. Verify service wiring after switch

```bash
sudo systemctl status r2-mount-documents
sudo systemctl status r2-bisync-documents
sudo systemctl status r2-mount-workspace
sudo systemctl status r2-bisync-workspace
sudo systemctl status r2-restic-backup
```

Expected result:

- mount services are active
- bisync and restic timers/services are present and invokable

## 6. Contract map (template -> command -> expected unit)

| Template | Config Path                                      | Verification Command                  | Expected Unit/Effect       |
| -------- | ------------------------------------------------ | ------------------------------------- | -------------------------- | ------------------- |
| minimal  | `services.r2-sync.mounts.documents`              | `systemctl status r2-mount-documents` | mount service exists       |
| minimal  | `services.r2-sync.mounts.documents.syncInterval` | `systemctl list-timers                | grep r2-bisync-documents`  | bisync timer exists |
| full     | `services.r2-sync.mounts.workspace`              | `systemctl status r2-mount-workspace` | mount service exists       |
| full     | `services.r2-restic.bucket`                      | `systemctl status r2-restic-backup`   | restic oneshot unit exists |
| full     | `programs.git-annex-r2.*`                        | `command -v git-annex-r2-init`        | helper is installed        |
| full     | `programs.r2-cloud.enable`                       | `command -v r2`                       | wrapper CLI is installed   |
