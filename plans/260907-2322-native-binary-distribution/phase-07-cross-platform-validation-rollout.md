# Phase NB-7 — Cross-Platform Validation and Rollout

## Context links

- [Master plan](./plan.md)
- [NB-4 build pipeline](./phase-04-assets-build-pipeline.md)
- [NB-5 lifecycle](./phase-05-install-update-uninstall.md)
- [NB-6 npm wrapper](./phase-06-npm-wrapper.md)
- [Current test documentation](/Users/anhlp/StudioProjects/alp-code/docs/architecture.md)
- [Current README](/Users/anhlp/StudioProjects/alp-code/README.md)

## Overview

- Priority: P1
- Status: pending
- Effort: 1.5-2 days
- Purpose: prove each advertised target on its real platform, exercise migration/failure paths, and stage v0.10 with a recoverable compatibility window.

## Test layers

1. Node dev regression: TypeScript/unit/integration/E2E and existing script suites.
2. Native black-box: extracted binary, cwd outside repo, no Node/Bun/npm on PATH.
3. Installer lifecycle: fresh install, repeat install, update, interrupted update, rollback, uninstall.
4. Migration: v0.9 npm/tarball → v0.10 binary/npm wrapper.
5. Runtime integration: real Claude/Codex hook/delegate behavior where credentials/environment permit.

## Files

- Create: `/Users/anhlp/StudioProjects/alp-code/scripts/test-binary.cjs` — host black-box suite driver.
- Create: `/Users/anhlp/StudioProjects/alp-code/scripts/test-binary-migration.cjs`.
- Create: `/Users/anhlp/StudioProjects/alp-code/scripts/test-binary-performance.cjs`.
- Create: `/Users/anhlp/StudioProjects/alp-code/.github/workflows/native-binary.yml` — build + target runtime matrix.
- Create: `/Users/anhlp/StudioProjects/alp-code/plans/260907-2322-native-binary-distribution/reports/release-readiness.md`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/README.md`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/docs/architecture.md`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/CHANGELOG.md`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/scripts/test-checkout-release.cjs`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/scripts/test-cut-release.cjs` only if release preflight contracts change.

## Tasks

### Task 7.1 — Preserve the Node development baseline

1. Run `npm run typecheck`.
2. Run `npm run build`.
3. Run `npm test`.
4. Run every `scripts/test-*.cjs` that is a Node/dev regression suite.
5. Keep these distinct from native black-box results; do not claim one covers the other.

### Task 7.2 — Run the target matrix

For each target, extract its release archive and execute it on matching OS/arch/libc:

| Target | Required runtime evidence |
|---|---|
| darwin-arm64 | native arm64 macOS runner/host |
| darwin-x64 | native x64 macOS runner/host |
| linux-x64-gnu | clean glibc x64 environment |
| linux-arm64-gnu | native or transparent arm64 runner; architecture reported |
| windows-x64 | real Windows x64 host, including paths with spaces |

Each target runs `--version`, help, doctor fixture, hook fixtures, state bootstrap, foreground child process and detached supervisor. `file(1)`/header inspection is supplemental only.

### Task 7.3 — Clean no-Node binary test

1. Remove Node/Bun/npm from test PATH while retaining only OS tools required by installer.
2. Install direct binary channel from release fixture.
3. Run `alp --version`, `alp doctor`, init/deinit and hook fixtures.
4. Inspect process tree during delegation fixture; no Node process may appear.
5. Verify unsupported libc/arch fails before download or activation.

### Task 7.4 — Migration matrix

1. Install v0.9.0 via npm; create memory, preferences, execution state and initialized project.
2. Upgrade to v0.10 npm wrapper and direct binary channel in separate fixtures.
3. Repeat from v0.9 tarball.
4. Hash user-owned state before/after; allow only documented generated-file migrations.
5. Verify old project loads identity at turn 1 and skill links survive `current` switch.
6. Run migration twice to prove idempotence.

### Task 7.5 — Failure and rollback matrix

1. Inject network cutoff, wrong checksum, malformed manifest, path traversal, wrong architecture and smoke failure.
2. Inject interruption before/after version rename and pointer switch.
3. Confirm previous command remains runnable and previous version remains present.
4. Exercise documented manual rollback without network.
5. Windows update/uninstall must report exact remaining files if the OS prevents cleanup.

### Task 7.6 — Performance gate

1. Benchmark direct binary `alp --version` on reference darwin-arm64.
2. Use at least 30 measured launches; report p50/p95, cold/warm method, hardware and OS.
3. Ensure version path has no update check, state mutation or child process.
4. Gate: p95 < 40 ms. If bytecode is evaluated, compare the same built source and compiler version.

### Task 7.7 — Documentation and staged rollout

1. Document supported target matrix and explicit non-goals: musl, Windows arm64, notarization.
2. Document direct binary as default, npm wrapper as supported fallback and dev clone separately.
3. Explain checksums accurately and provide manual rollback/uninstall instructions.
4. v0.10 release includes native archives, checksums, npm wrapper and legacy hooks.
5. Do not delete legacy hooks until v0.11 and only after migration evidence from v0.10.
6. If any target lacks runtime evidence, withhold its stable asset or label it experimental; do not claim support.

### Task 7.8 — Release readiness record

1. Record artifact digests, compiler version and source tag/commit.
2. Attach command output for every release gate.
3. List known limitations and deferred work.
4. Do not publish/upload as part of plan execution without explicit principal authorization.

## Todo

- [ ] Node dev baseline passes
- [ ] Five target artifacts execute on matching hosts
- [ ] Clean no-Node direct install passes
- [ ] npm/tarball v0.9 migrations pass
- [ ] Failure/rollback matrix preserves current installation
- [ ] Direct binary performance gate passes
- [ ] README/architecture/changelog match actual support
- [ ] Release readiness report contains fresh evidence
- [ ] Legacy hooks remain in v0.10

## Success criteria

- Every advertised platform has runtime evidence, not only cross-build evidence.
- Fresh install, update, rollback and uninstall are recoverable without touching user memory.
- v0.10 can be released with a clear fallback and no false Windows/Linux support claim.

## Risks and security

- CI credentials must not be available to untrusted downloaded artifacts.
- Real-runtime tests should use isolated state/workspaces and avoid exposing user credentials in logs.
- Release upload/npm publish remain separate, explicitly authorized operations.

## Deferred after v0.10

- v0.11 removal of legacy hook scripts after migration evidence.
- Linux musl and Windows arm64 targets.
- macOS signing/notarization and independent artifact signatures.
- Homebrew formula and binary size optimization.

