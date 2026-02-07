# Option Reference

Canonical option reference for all public module surfaces in this repository.

## NixOS modules

- [`services.r2-sync`](./services-r2-sync.md)
- [`services.r2-restic`](./services-r2-restic.md)
- [`programs.git-annex-r2`](./programs-git-annex-r2.md)

## Home Manager modules

- [`programs.r2-cloud`](./programs-r2-cloud.md)
- [`programs.r2-cloud.credentials`](./programs-r2-cloud-credentials.md)
- [`programs.r2-cloud` managed rclone config behavior](./programs-r2-cloud-rclone-config.md)

## Scope and guarantees

- Each option entry includes type, default, requirement semantics, and a usage snippet.
- Failure semantics are listed using the exact assertion messages from module code.
- For architecture and phased roadmap context, see `docs/plan.md`.
