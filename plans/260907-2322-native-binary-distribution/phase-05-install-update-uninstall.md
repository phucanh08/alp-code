# Phase NB-5 — Install, Update and Uninstall

## Context links

- [Master plan](./plan.md)
- [NB-1 install layout](./phase-01-install-layout-static-boundary.md)
- [NB-4 artifact contract](./phase-04-assets-build-pipeline.md)
- [Current POSIX installer](/Users/anhlp/StudioProjects/alp-code/install.sh)
- [Current Windows installer](/Users/anhlp/StudioProjects/alp-code/install.ps1)
- [Current updater](/Users/anhlp/StudioProjects/alp-code/scripts/lib/update.cjs)
- [Current uninstall](/Users/anhlp/StudioProjects/alp-code/scripts/lib/uninstall.cjs)

## Overview

- Priority: P1
- Status: pending
- Effort: 2-2.5 days
- Purpose: install and replace immutable versions safely, with a stable command, recoverable rollback and no Node requirement in binary channel.

## Update state machine

```text
resolve exact tag/target
  → download archive + SHA256SUMS
  → verify digest
  → validate archive entries
  → extract to unique staging
  → validate manifest + assets
  → run staged binary --version/doctor smoke
  → rename staging to versions/<tag>
  → atomically replace current
  → run new binary __internal ensure-state
  → retain previous known-good version
```

Never remove the current version directory before the new `current` pointer is live.

## Files

- Create: `/Users/anhlp/StudioProjects/alp-code/src/install/archive.ts` — target archive download/validation.
- Create: `/Users/anhlp/StudioProjects/alp-code/src/install/update.ts` — binary update state machine.
- Create: `/Users/anhlp/StudioProjects/alp-code/src/install/uninstall.ts` — channel-aware uninstall.
- Create: `/Users/anhlp/StudioProjects/alp-code/src/install/doctor.ts` — statically bundled health checks.
- Create: `/Users/anhlp/StudioProjects/alp-code/test/install/archive.test.ts`.
- Create: `/Users/anhlp/StudioProjects/alp-code/test/install/update.test.ts`.
- Create: `/Users/anhlp/StudioProjects/alp-code/test/install/uninstall.test.ts`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/install.sh`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/install.ps1`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/src/cli/alp.ts`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/scripts/lib/update.cjs` — legacy Node wrapper only.
- Modify: `/Users/anhlp/StudioProjects/alp-code/scripts/lib/uninstall.cjs` — legacy Node wrapper only.
- Modify: `/Users/anhlp/StudioProjects/alp-code/scripts/lib/cli-link.cjs`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/scripts/bootstrap.cjs`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/scripts/test-installer.cjs`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/scripts/test-windows-installer.cjs`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/scripts/test-update.cjs`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/scripts/test-uninstall.cjs`.

## Tasks

### Task 5.1 — Platform detection and clean install

1. Write installer tests for supported OS/arch/libc and explicit unsupported errors.
2. Move Node preflight inside npm/dev branches; binary auto channel must not require Node.
3. Resolve release tag, exact target archive and checksum.
4. Apply archive validation and staged smoke before installing.
5. Create `current` and the platform stable command without overwriting a foreign command.
6. Run new executable `__internal ensure-state`; report actionable error if state initialization fails.

### Task 5.2 — Atomic current replacement

1. Add failure-injection tests at every update state transition.
2. POSIX: create temporary symlink and rename it over `current` without pre-unlinking `current`.
3. Windows: test junction/pointer replacement on a real Windows host; use only measured semantics.
4. On pointer-switch failure, preserve old pointer and both complete version directories.
5. Prune only after new state bootstrap succeeds; retain current and previous known-good versions.

### Task 5.3 — Binary self-update

1. Pass current version from build info; never read package version from runtime `package.json`.
2. Require staged binary to report exactly the target release version.
3. Prevent downgrade unless an explicit future rollback command is introduced; manual pointer rollback remains documented.
4. Serialize concurrent update attempts with a bounded installation lock.
5. Clean stale staging/lock files without deleting valid version directories.

### Task 5.4 — State migration and rollback behavior

1. Test v0.9 npm and tarball install records.
2. After pointer switch, run new state migration and hook repair.
3. If state migration reports a recoverable project repair warning, keep the working new binary and surface doctor remediation.
4. If core state validation fails, do not prune previous version; provide exact manual rollback command.
5. Verify `~/.alp` content hashes before/after update except explicitly migrated generated files.

### Task 5.5 — Native uninstall

1. Preserve memory backup and selective state ownership rules.
2. Binary channel removes stable command/current pointer before deleting inactive versions.
3. npm channel delegates package ownership to npm and removes only the wrapper-managed cache.
4. Windows: implement and test delayed cleanup after executable exit, or leave locked inactive binary with a precise cleanup instruction; never report removal when it remains.
5. Keep cwd/root safety checks and foreign-command protection.

### Task 5.6 — Doctor parity

1. Port doctor checks into static TypeScript APIs.
2. Keep exit `0/1/2` and output labels compatible.
3. Add binary-layout checks for manifest, target, assets, stable command and stale `current`.
4. Run doctor from extracted artifact with cwd outside installation.

## Todo

- [ ] Binary install path has no Node preflight
- [ ] Archive/checksum/manifest validated before cutover
- [ ] `current` replacement has no unlink gap on POSIX
- [ ] Failure injection preserves old installation
- [ ] Previous known-good version retained
- [ ] Native update uses build-time version
- [ ] Windows update/uninstall behavior measured
- [ ] Doctor is statically bundled

## Success criteria

- Broken, tampered or wrong-target archive never changes `current`.
- Update can be interrupted at any injected point without losing a runnable previous version.
- Binary install/update/uninstall does not spawn Node.
- User memory and preferences remain unchanged.

## Risks and security

- Validate release redirects and cap download/archive sizes.
- Avoid shell interpolation for tag, paths and target names.
- Lock files must include stale-owner recovery and cannot become permanent denial of update.
- Do not recursively delete paths derived only from environment variables without layout validation.

## Next

- NB-6 adds npm as a wrapper channel over the same archive/update primitives.

