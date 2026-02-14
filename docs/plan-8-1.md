# Phase 8.1 Complete Implementation Plan (Final, Feedback-Integrated)

## Status

- Completed on **2026-02-14**.
- Execution evidence is recorded in `docs/plan.md` under
  `8.1 Completion Evidence (2026-02-14)`.
- Remaining Phase 8 runtime milestones are planned in `docs/plan-8-2.md`.

## Summary

Phase 8.1 delivered consumer integration readiness between:

1. **nix-R2-CloudFlare-Flake** (producer): add account-ID file support and
   runtime-safe resolution primitives.
2. **~/nixos** (consumer): wire flake input/modules for host `system76`, add
   required secrets plumbing, and prevent Home Manager collisions.

This phase was intentionally limited to integration/evaluation correctness
(`flake check` + `dry-activate`) and did not enable operational services
(that moves to 8.2 staged enablement).

## Goals And Exit Criteria

1. `~/nixos` can import r2-cloud modules for `system76` without
   option/assertion conflicts.
2. New account-ID source model supports `accountId` or `accountIdFile` with
   explicit runtime fallback semantics.
3. HM legacy/new module collisions are eliminated deterministically.
4. `nix flake check` passes in both repos.
5. `sudo nixos-rebuild dry-activate --flake ~/trees/nixos/phase-8-1-consumer-integration#system76`
   passes.
6. `docs/plan.md` updates 8.1 to complete with evidence.

## Branch And Worktree Setup

1. **Producer repo:**
   - Repo: `/home/vx/git/nix-R2-CloudFlare-Flake`
   - Branch: `phase-8-1-accountidfile-support`
   - Worktree: `~/trees/nix-R2-CloudFlare-Flake/phase-8-1-accountidfile-support`

2. **Consumer repo:**
   - Repo: `/home/vx/nixos`
   - Branch: `phase-8-1-consumer-integration`
   - Worktree: `~/trees/nixos/phase-8-1-consumer-integration`

3. During development, consumer input points to producer worktree path:
   - `path:/home/vx/trees/nix-R2-CloudFlare-Flake/phase-8-1-accountidfile-support`

## Scope Boundaries

### In scope (8.1)

- API additions/options + resolver refactors.
- Consumer import wiring.
- Secret source file creation + SOPS declarations.
- HM collision handling.
- Evaluation/dry-activate verification.
- Documentation updates for new semantics.

### Out of scope (8.2)

- `enable = true` rollout for `services.r2-sync`, `services.r2-restic`,
  `programs.git-annex-r2`, `programs.r2-cloud`.
- Runtime service/timer status checks.
- Live R2/restic/share flow validation.

---

## Repo A: nix-R2-CloudFlare-Flake Detailed Changes

### A1. Shared Resolver Utility (`lib/r2.nix`)

Update `lib/r2.nix` from `_: { ... }` to `{ lib, ... }: { ... }` and add a
shared generator:

```nix
mkResolveAccountIdShell = {
  literalAccountId,
  accountIdFile,
  envVar ? "R2_ACCOUNT_ID",
  outputVar ? "R2_RESOLVED_ACCOUNT_ID",
}: "<shell fragment>";
```

**Behavior (decision-complete):**

1. Initialize output variable empty.
2. If literal account ID is non-empty, use it.
3. Else if `accountIdFile` path is non-empty and readable, read first line
   from file.
   - `accountIdFile` is a single-value text file (for example
     `/run/secrets/r2/account-id`) extracted by sops-nix, not the YAML source.
   - Use builtin-safe read under `set -e`:
     `{ IFS= read -r <var> || true; } < "$file"`
4. Else fallback to runtime env var (`R2_ACCOUNT_ID` by default).
5. Trim leading/trailing whitespace.
6. Validate non-empty; emit explicit fail-fast error on empty/unresolved.
7. No external `cat` dependency; use shell builtins for portability and
   deterministic behavior.

**Rationale:**

- Single source of logic prevents drift across modules.
- Explicit `read || true` avoids premature exit under `set -e` for empty-file
  EOF and preserves intended error messaging.

### A2. `modules/nixos/r2-sync.nix`

1. **Add option:**
   - `services.r2-sync.accountIdFile` (`nullOr path`, default `null`).

2. **Assertion change:**
   - Replace hard literal requirement with:
     `cfg.accountId != "" || cfg.accountIdFile != null`
   - Keep existing assertions for credentials/mount definitions.

3. **Runtime wrapper refactor:**
   - Convert `ExecStart` in both mount and bisync services to wrapper scripts
     that:
     1. Source `EnvironmentFile` as systemd already does.
     2. Resolve account ID via `mkResolveAccountIdShell`.
     3. Build endpoint at runtime:
        `https://$R2_RESOLVED_ACCOUNT_ID.r2.cloudflarestorage.com`
     4. `exec rclone ... --s3-endpoint="$endpoint"`.

4. **Service type:**
   - Mount service retains `Type = "simple"`.
   - Bisync service retains `Type = "oneshot"`.
   - Wrappers must terminate with `exec` for correct lifecycle behavior.

5. **ExecStop unchanged:**
   - `ExecStop` uses `fusermount -u` / `umount` and does not need account ID
     resolution.

### A3. `modules/nixos/r2-restic.nix`

1. **Add option:**
   - `services.r2-restic.accountIdFile` (`nullOr path`, default `null`).

2. **Assertion change:**
   - `cfg.accountId != "" || cfg.accountIdFile != null`
   - Keep existing assertions for credentials/password/bucket/paths/retention.

3. **Runtime repository construction:**
   - Move endpoint/repo construction out of static `environment`.
   - In backup wrapper:
     1. Resolve account ID via shared helper.
     2. `export RESTIC_REPOSITORY="s3:https://$id.r2.cloudflarestorage.com/${cfg.bucket}"`
     3. Run backup + forget/prune as currently designed.

### A4. `modules/home-manager/r2-cli.nix`

1. **Add option:**
   - `programs.r2-cloud.accountIdFile` (`nullOr path`, default `null`).

2. **Assertion update:**
   - `programs.r2-cloud.enable` requires either non-empty literal `accountId`
     or `accountIdFile`.
   - Credentials file requirement unchanged.

3. **Wrapper runtime resolution:**
   - Resolve default account ID in this order:
     1. Literal option.
     2. `accountIdFile`.
     3. `R2_ACCOUNT_ID` from credentials file.
   - Export resolved `R2_DEFAULT_ACCOUNT_ID` only after validation.
   - Export `RCLONE_CONFIG_<REMOTE>_ENDPOINT` when endpoint-less mode is used:
     - `<REMOTE>` is `rcloneRemoteName` uppercased and must be env-var-safe
       (`[A-Za-z0-9_]+`).
     - Value: `https://$R2_RESOLVED_ACCOUNT_ID.r2.cloudflarestorage.com`.

### A4.5. `modules/home-manager/r2-credentials.nix`

Extend account ID resolution to include file-based sources:

1. **Add option:**
   - `programs.r2-cloud.credentials.accountIdFile` (`nullOr path`, default `null`).

2. **Resolution order (effectiveAccountId):**
   1. `programs.r2-cloud.credentials.accountId`
   2. `programs.r2-cloud.accountId`
   3. `programs.r2-cloud.credentials.accountIdFile`
   4. `programs.r2-cloud.accountIdFile`

3. **Assertions:**
   - Accept file-only configs (no literal account ID required).
   - Error message must mention both literal and file options.

### A5. `modules/home-manager/rclone-config.nix`

1. Keep `enableRcloneRemote` behavior.

2. If literal `accountId` exists:
   - Render static endpoint in `rclone.conf`.

3. If literal missing but file/runtime mode used:
   - Generate remote stanza without endpoint line.

4. **Assertions:**
   - Keep `rcloneConfigPath`/`rcloneRemoteName` validity assertions.
   - Do **not** require declarative account source specifically for remote
     generation.

**Important documented tradeoff:**

- In endpoint-less mode, bare `rclone ... r2:` requires manual
  `RCLONE_CONFIG_<REMOTE>_ENDPOINT` export.
- `r2` wrapper and `git-annex-r2-init` set runtime env automatically.

### A6. `modules/nixos/git-annex.nix`

Update runtime behavior for endpoint-less remotes:

1. Resolve account ID from credentials file (`R2_ACCOUNT_ID`).
2. Export `RCLONE_CONFIG_<REMOTE>_ENDPOINT` for the configured rclone remote
   name (uppercased, env-var-safe).
3. Fail fast with explicit error if remote name cannot be converted to a valid
   env var name.

### A7. Producer Docs Updates

Update:

1. `docs/reference/services-r2-sync.md`
2. `docs/reference/services-r2-restic.md`
3. `docs/reference/programs-r2-cloud.md`
4. `docs/reference/programs-r2-cloud-rclone-config.md`
5. `docs/plan.md` (8.1 completion note only after validation success)

---

## Repo B: ~/nixos Detailed Changes

### B1. Flake Input Wiring

In `~/trees/nixos/phase-8-1-consumer-integration/flake.nix`:

- Add `r2-cloud` input using local `path:` producer worktree reference.

### B2. NixOS Module Wiring (`system76`)

Add `inputs.r2-cloud.nixosModules.default` in system76 host import chain
(`configurations.nixos.system76.module` path used by existing architecture).

### B3. HM Module Wiring + Legacy Disable (Consolidated)

Use a single `home-manager.sharedModules` assignment for `system76` containing
both:

1. `inputs.r2-cloud.homeManagerModules.default`
2. Inline override module `{ programs.r2-legacy.enable = false; }`

This keeps host wiring atomic and avoids split list contributions.

### B4. Legacy HM Module Gate

Modify `~/nixos/modules/home/r2-user.nix`:

1. **Add option:**
   - `programs.r2-legacy.enable` (boolean, default `true`).

2. **Guard all legacy outputs behind this option:**
   - `home.packages` additions (`r2`, `r2c`, `r2s5`).
   - `xdg.configFile."rclone/rclone.conf"` and related legacy docs files.

**Result:**

- Existing hosts retain legacy behavior by default.
- `system76` disables legacy paths when new r2-cloud HM module is active,
  preventing filename/package collisions.

### B5. New Secrets Module (flake-parts pattern)

Create `~/nixos/modules/security/r2-cloud-secrets.nix` following
`flake.nixosModules.base` contribution pattern and include `inputs` in module
args.

Standardize on a single YAML secrets file with explicit key extraction.

Secrets source file:

- `secrets/r2.yaml`

Declare system secrets (all `format = "yaml"`):

1. `/run/secrets/r2/account-id` from key `account_id`
2. `/run/secrets/r2/access-key-id` from key `access_key_id`
3. `/run/secrets/r2/secret-access-key` from key `secret_access_key`
4. `/run/secrets/r2/restic-password` from key `restic_password`

Generate the env credentials file required by system services:

5. `sops.templates."r2-credentials.env"` renders `/run/secrets/r2/credentials.env`
   with:
   - `R2_ACCOUNT_ID`
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`

### B5.5 SOPS Policy Update (Required)

Before creating new YAML secrets, update
`~/nixos/modules/security/sops-policy.nix` to include creation rules for:

- `path_regex: secrets/r2.yaml`

Then regenerate `.sops.yaml` from policy source:

- `nix develop -c write-files`

### B6. Secret Source Creation And Encryption

1. Create `secrets/r2.yaml`:
   ```yaml
   account_id: <cloudflare-account-id>
   access_key_id: <access-key-id>
   secret_access_key: <secret-access-key>
   restic_password: <generated-password>
   ```
   Encrypt in place via `sops -e -i`.

### B7. SOPS Key Compatibility Verification (Explicit)

Before final checks, verify system-level decryption compatibility:

1. Confirm identity used by `/var/lib/sops-nix/key.txt` can decrypt:
   - `secrets/r2.yaml`
   - all declared keys can be extracted to `/run/secrets/r2/*`.
   - template output at `/run/secrets/r2/credentials.env` renders and contains
     all three required env variables.

2. If decrypt fails, add proper recipient(s) and re-encrypt files before
   proceeding.

---

## Gate Sequence (Final)

| Gate  | Description                                                                                          |
| ----- | ---------------------------------------------------------------------------------------------------- |
| **A** | Create both branches/worktrees.                                                                      |
| **B** | Implement repo-A changes; run producer `nix flake check`.                                            |
| **D** | Add repo-B secret module + source files; ensure evaluation.                                          |
| **E** | Add repo-B input/module wiring for `system76`.                                                       |
| **C** | Verify HM collision-free integration with consolidated `sharedModules` + legacy disabled.            |
| **F** | Run consumer `nix flake check`.                                                                      |
| **G** | Run `sudo nixos-rebuild dry-activate --flake ~/trees/nixos/phase-8-1-consumer-integration#system76`. |
| **H** | Document evidence and mark 8.1 complete in `docs/plan.md`.                                           |

---

## Test Plan And Acceptance Scenarios

### Producer Module Tests

1. **`services.r2-sync`:**
   - Literal `accountId` only → eval pass.
   - `accountIdFile` only → eval pass.
   - Neither → eval fail with expected assertion text.

2. **`services.r2-restic`:**
   - Same matrix as above.

3. **`programs.r2-cloud` + `rclone-config`:**
   - Literal-only mode → endpoint rendered in config.
   - File-only / env-driven mode → no endpoint line; wrapper path
     documented/works.
   - Bare `rclone ... r2:` without endpoint env in endpoint-less mode fails as
     documented.

4. **`programs.r2-cloud.credentials`:**
   - `manage = true` + `accountIdFile` only → eval pass.
   - Neither literal nor file account ID → eval fail with expected assertion.

5. **Resolver script behavior:**
   - Empty account file with `set -e` produces explicit resolver error (not
     premature shell exit).
   - Whitespace-only values rejected.
   - Env fallback works when provided.

### Consumer Integration Tests

1. **HM collision checks:**
   - No duplicate `r2` package providers in HM generation.
   - No duplicate ownership for `rclone/rclone.conf`.

2. **Secrets declarations:**
   - Expected `/run/secrets/r2/*` paths declared and evaluable.
   - Encryption of `secrets/r2.yaml` succeeds only after SOPS policy update
     - `nix develop -c write-files`.
   - `sops.templates."r2-credentials.env"` renders valid env output.

3. **Flake checks:**
   - `nix flake check` passes in both repos.

4. **Activation check:**
   - `dry-activate` passes for `system76` without module assertion failures.

---

## flake.lock Policy During 8.1

1. Expected: `~/nixos/flake.lock` changes during `path:` development.
2. Commit lock updates when needed for reproducible gate results.
3. Later (post-8.1), replace local `path:` input with canonical remote URL
   and refresh lock accordingly.

---

## Assumptions

1. Target host is `system76`.
2. Required system secret paths:
   - `/run/secrets/r2/account-id`
   - `/run/secrets/r2/access-key-id`
   - `/run/secrets/r2/secret-access-key`
   - `/run/secrets/r2/restic-password`
   - `/run/secrets/r2/credentials.env`
3. All new secrets for 8.1 live in `secrets/r2.yaml` and are extracted by key.
4. Backward compatibility is not a requirement for 8.1; standardization wins.
5. 8.1 ends at integration/evaluation proof; staged runtime enablement
   remains in 8.2.
