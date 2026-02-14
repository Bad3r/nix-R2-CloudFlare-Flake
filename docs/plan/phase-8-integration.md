# Phase 8: ~/nixos integration + runtime validation

## Verification

### After Consumer Integration

```bash
# On consumer system after nixos-rebuild
r2 bucket list
r2 bucket create test-bucket
r2 bucket lifecycle add test-bucket trash-cleanup .trash/ --expire-days 30
# Verify lifecycle (requires wrangler in PATH)
wrangler r2 bucket lifecycle list test-bucket
sudo systemctl status r2-mount-documents
ls /mnt/r2/documents

# Test sync
echo "test" > /mnt/r2/documents/test.txt
sudo systemctl start r2-bisync-documents
r2 rclone ls r2:documents/

# Test sharing
# Presigned (S3 endpoint only)
r2 share documents test.txt

# Worker share (custom domain)
# Recommended: wire Worker admin signing via `programs.r2-cloud.explorerEnvFile`
# (for example `/run/secrets/r2/explorer.env`) so the wrapper can run Worker
# share commands without manual exports.
r2 share worker create files documents/test.txt 24h --max-downloads 1
r2 share worker list files documents/test.txt
```

## Phase 8 Milestone Matrix (`~/nixos` Integration + Runtime Validation)

| Milestone                                 | Scope / Tasks                                                                                                                                                | Deliverables                                                                             | Exit Criteria                                                                                            | Status |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------ |
| **8.1 Consumer integration in `~/nixos`** | Integrate this flake as an input in the main system config and wire `nixosModules.default` (+ Home Manager module where used) into target host/user configs. | Updated `~/nixos` flake wiring and host/user module imports.                             | `nixos-rebuild dry-activate --flake ~/nixos#system76` passes with module assertions satisfied.           | [x]    |
| **8.2 Staged service enablement**         | Enable core options in staged order (`r2-sync` first, then `r2-restic`, then `git-annex` and CLI wrappers) to isolate failures cleanly.                      | Host config with explicit staged enablement and secrets mapping.                         | `nixos-rebuild switch --flake ~/nixos#system76` succeeds for each stage without hidden/manual patching.  | [x]    |
| **8.3 Runtime service verification**      | Verify mount/bisync/restic/timers/CLI surfaces on the real host managed by `~/nixos`.                                                                        | Service/timer + command verification checklist with observed outputs.                    | Core units/timers are active/invokable and `r2`/`git-annex-r2-init` resolve in PATH.                     | [x]    |
| **8.4 Remote connectivity validation**    | Validate live R2 and restic connectivity using runtime secrets on the managed host.                                                                          | Successful `rclone`/`restic` checkpoints (or explicit failure signatures + fixes).       | Remote `files` listing and `restic snapshots` checks pass with expected auth semantics.                  | [x]    |
| **8.5 Sharing UX validation**             | Validate presigned and Worker-based share flows from the managed system, including Access split behavior.                                                    | End-to-end share test evidence (`r2 share`, `r2 share worker create/list`, curl probes). | Tokenized share works and `/api/*` remains Access-protected.                                             | [x]    |
| **8.6 Acceptance + feedback loop**        | Record evidence, unresolved issues, and feed real-user friction back into quickstart/runbooks/troubleshooting docs.                                          | Phase 8 closure note + doc refinements informed by first-user run.                       | One successful full-stack run documented with reproducible commands and outcomes from `~/nixos` context. | [x]    |

Detailed execution documents:

- `docs/plan/phase-8-1-consumer-integration.md`: completed 8.1 integration execution record.
- `docs/plan/phase-8-2-runtime-enablement-validation.md`: gate-driven execution plan for milestones 8.2 through 8.6.

### Phase 8 Runtime Bring-Up Checklist (8.2-8.5 Draft)

1. Treat `~/nixos` as the source of truth for actual usage (do not run daily
   operations from a standalone template project).
2. Confirm `8.1` integration baseline still evaluates in `~/nixos` and required
   `/run/secrets/r2/*` paths exist on host.
3. Enable runtime features in staged order to isolate failures:
   - stage 1: `services.r2-sync`
   - stage 2: `services.r2-restic`
   - stage 3: `programs.git-annex-r2` and HM `programs.r2-cloud`
4. Validate in `~/nixos` after each stage:
   - `nix flake check`
   - `sudo nixos-rebuild dry-activate --flake ~/nixos#system76`
   - `sudo nixos-rebuild switch --flake ~/nixos#system76`
5. Verify runtime units/timers and CLI on the host:
   - `r2-mount-*`, `r2-bisync-*`, `r2-restic-backup`, timers
   - `command -v r2`
   - `command -v git-annex-r2-init`
6. Verify remote connectivity:
   - `rclone lsf :s3:files ...`
   - `restic ... snapshots`
7. Verify sharing UX from the managed system:
   - `r2 share ...`
   - `r2 share worker create/list ...`
   - `curl -I "<share_url>"` (share URLs often contain `?`, so always quote)
   - `curl -I https://files.unsigned.sh/api/list`
8. Capture evidence/failures by gate and update quickstart/troubleshooting/docs
   for any first-user friction discovered during runtime validation.

### 8.1 Completion Evidence (2026-02-14)

- Consumer integration branch:
  - `~/trees/nixos/phase-8-1-consumer-integration`
  - producer input wired as a portable flake source:
    `github:Bad3r/nix-R2-CloudFlare-Flake?ref=main` (consumer input name: `r2-flake`)
- Consumer evaluation/build validation:
  - `nix build .#nixosConfigurations.system76.config.system.build.toplevel --offline` succeeded.
  - `nix eval .#nixosConfigurations.system76.config.sops.secrets --apply builtins.attrNames --json --offline` includes:
    - `r2/account-id`
    - `r2/access-key-id`
    - `r2/secret-access-key`
    - `r2/restic-password`
- Host activation evidence:
  - configuration applied with `nh` on `system76` without integration assertion failures.
  - activation diff added:
    - `cloudflare-r2-env`
    - `r2-credentials.env`
  - activation diff removed legacy HM artifacts:
    - `hm_cloudflarer2README`
    - `hm_rclonerclone.conf`
    - `r2`
    - `r2c`
    - `r2s5`
- Runtime secret materialization evidence on host:
  - `/run/secrets/r2/account-id`
  - `/run/secrets/r2/access-key-id`
  - `/run/secrets/r2/secret-access-key`
  - `/run/secrets/r2/restic-password`
  - `/run/secrets/r2/credentials.env` (rendered template symlink target)

### 8.2-8.6 Completion Evidence (2026-02-15)

- `~/nixos` enablement state:
  - `services.r2-sync.enable` / `services.r2-restic.enable` / `programs.git-annex-r2.enable` all evaluate to `true`.
  - HM wrapper is enabled for user `vx`:
    `home-manager.users.vx.programs.r2-cloud.enable = true`.
- Runtime health on `system76`:
  - `r2-mount-workspace.service` active and mount is host-visible:
    `mountpoint -q /data/r2/mount/workspace` succeeds.
  - timers active: `r2-bisync-workspace.timer`, `r2-restic-backup.timer`.
- Live remote connectivity (runtime secrets only):
  - `rclone lsf :s3:nix-r2-cf-r2e-files-prod ...` succeeds.
  - `restic ... snapshots` succeeds against `nix-r2-cf-backups-prod`.
- Sharing UX (managed system):
  - presigned `r2 share nix-r2-cf-r2e-files-prod workspace/demo.txt 1h` returns a URL.
  - Worker token flow works on `https://files.unsigned.sh/share/<token>`:
    - first `GET` returns `200`
    - second `GET` returns `410` when created with `--max-downloads 1`
  - `curl -I https://files.unsigned.sh/api/list` returns `401` (Access remains enforced).
- Worker admin signing is persistent (no manual exports required):
  - `explorer_admin_{kid,secret}` stored in SOPS-managed `~/nixos/secrets/r2.yaml`,
    rendered to `/run/secrets/r2/explorer.env`,
    and wired via `programs.r2-cloud.explorerEnvFile`.
