# r2-cloud-nix: Plan

This plan is split by phase under `docs/plan/` to keep `docs/plan.md` readable.

## Architecture

See [Phase 1: Repository scaffold + flake.nix](./plan/phase-1-scaffold.md) for the
high-level architecture diagram and key design decisions.

## Implementation order

1. [x] **Phase 1**: [Repository scaffold + flake.nix](./plan/phase-1-scaffold.md)
2. [x] **Phase 2**: [NixOS modules (r2-sync.nix, r2-restic.nix)](./plan/phase-2-nixos-modules.md)
3. [x] **Phase 3**: [Home Manager modules (`r2` wrapper, credentials assembly, managed `rclone.conf`)](./plan/phase-3-home-manager-modules.md)
4. [x] **Phase 4**: [CLI package extraction/refactor (single `r2` package CLI + HM wrapper delegation)](./plan/phase-4-cli.md)
5. [x] **Phase 5**: [R2-Explorer subflake (Hono+Zod contracts, middleware layering, `/api/v2/session/info`, worker tests)](./plan/phase-5-worker.md)
6. [x] **Phase 6**: [Templates and documentation](./plan/phase-6-templates-docs.md)
7. [x] **Phase 7**: [CI/CD setup](./plan/phase-7-ci-cd.md)
8. [x] **Phase 8**: [Real-user adoption via `~/nixos` integration (consumer input wiring + runtime validation + docs feedback loop)](./plan/phase-8-integration.md) (complete 2026-02-15)

Phase 5 now includes the secure multipart migration: control-plane/data-plane
split (`/api/v2/upload/init` + `/api/v2/upload/sign-part` + `/api/v2/upload/complete` +
`/api/v2/upload/abort`), direct browser-to-R2 part uploads, and removal of the
legacy Worker-proxied `/api/v2/upload/part` route.

## Phase 8 detailed execution docs

- `docs/plan/phase-8-1-consumer-integration.md`: completed 8.1 integration execution record.
- `docs/plan/phase-8-2-runtime-enablement-validation.md`: gate-driven execution plan for milestones 8.2 through 8.6.
- `docs/plan/status.md`: current production status snapshot and next actions.
