# Phase 6: Templates and documentation

## Usage Examples

### Minimal Setup (Consumer's flake.nix)

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager.url = "github:nix-community/home-manager";
    r2-cloud.url = "github:username/r2-cloud-nix";
  };

  outputs = { nixpkgs, home-manager, r2-cloud, ... }: {
    nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
      modules = [
        r2-cloud.nixosModules.default
        {
          services.r2-sync = {
            enable = true;
            accountIdFile = "/run/secrets/r2/account-id";
            credentialsFile = "/run/secrets/r2/credentials.env";
            mounts.documents = {
              bucket = "my-documents";
              remotePrefix = "documents";
              mountPoint = "/mnt/r2/documents";
              syncInterval = "10m";
            };
          };
        }
      ];
    };

    homeConfigurations.myuser = home-manager.lib.homeManagerConfiguration {
      modules = [
        r2-cloud.homeManagerModules.default
        {
          programs.r2-cloud = {
            enable = true;
            accountIdFile = "/run/secrets/r2/account-id";
          };
        }
      ];
    };
  };
}
```

### Full Setup with Restic

```nix
{
  services.r2-sync = {
    enable = true;
    accountIdFile = "/run/secrets/r2/account-id";
    credentialsFile = "/run/secrets/r2/credentials.env";

    mounts = {
      documents = {
        bucket = "documents";
        remotePrefix = "documents";
        mountPoint = "/mnt/r2/documents";
        syncInterval = "5m";
      };
      photos = {
        bucket = "photos";
        remotePrefix = "photos";
        mountPoint = "/mnt/r2/photos";
        syncInterval = "15m";
        vfsCache.maxSize = "20G";
      };
    };
  };

  services.r2-restic = {
    enable = true;
    accountIdFile = "/run/secrets/r2/account-id";
    credentialsFile = "/run/secrets/r2/credentials.env";
    passwordFile = "/run/secrets/r2/restic-password";
    bucket = "backups";
    paths = [ "/home/user/important" "/mnt/r2/documents" ];
    exclude = [ "*.tmp" ".cache" "node_modules" ];
    schedule = "daily";
    retention = {
      daily = 7;
      weekly = 4;
      monthly = 12;
    };
  };
}
```

## Phase 6 Milestone Matrix (Templates + Documentation)

| Milestone                          | Scope / Tasks                                                                                                                                         | Deliverables                                                                                                               | Exit Criteria                                                                                                                       | Status |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **6.1 Template hardening**         | Finalize `templates/minimal` and `templates/full`; ensure both include valid pinned inputs and runnable examples for current module options.          | Updated template flakes and inline comments.                                                                               | `nix flake check` passes for template-generated repos; quickstart commands run without manual patching.                             | [x]    |
| **6.2 Option reference docs**      | Document NixOS + Home Manager options with defaults, required fields, and failure semantics.                                                          | `docs/` reference pages for `services.r2-sync`, `services.r2-restic`, `programs.r2-cloud`, credentials, and rclone config. | Every public option in modules has corresponding docs entry and example snippet.                                                    | [x]    |
| **6.3 Operator runbooks**          | Add operational procedures: key rotation, readonly maintenance windows, Access policy split, incident response, and rollback of Worker/share configs. | Runbook sections in `docs/sharing.md` and dedicated operator docs.                                                         | A new operator can execute setup/rotation/recovery using docs only.                                                                 | [x]    |
| **6.4 End-user workflows**         | Expand practical usage docs for sync, backup, annex, and worker share flows across local + remote contexts.                                           | Updated `docs/quickstart.md`, `docs/sync.md`, `docs/versioning.md`, and quickstart-linked sharing flow guidance.           | Template-specific local + remote workflows (including worker-share checkpoints) are complete and verified against current commands. | [x]    |
| **6.5 Troubleshooting matrix**     | Add common failure signatures and root-cause/repair paths for auth, lifecycle, bisync, restic, multipart upload, and token validation.                | Troubleshooting section(s) with command-level diagnostics.                                                                 | Each critical subsystem has at least one known-failure diagnostic workflow.                                                         | [x]    |
| **6.6 Documentation quality gate** | Ensure docs stay synchronized with code changes via validation checks and explicit review checklist.                                                  | Updated validation guidance in docs and CI docs checks (Phase 7 wiring reference).                                         | No stale phase language remains; docs reviewed against current repository behavior.                                                 | [x]    |

### 6.4 Closure Note (2026-02-07)

- Closure criteria are now satisfied in current docs:
  - template-specific verification paths are explicit in `docs/quickstart.md`,
    `docs/sync.md`, and `docs/versioning.md`
  - local and remote expected outcomes are explicit in quickstart sync/backup
    checkpoints
  - worker-share checkpoint now verifies both public `/share/<token>` behavior
    and Access protection on `/api/*`
