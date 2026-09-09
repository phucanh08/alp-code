# Phase NB-3 — Hook Migration

## Context links

- [Master plan](./plan.md)
- [NB-2 lightweight entry](./phase-02-lightweight-entry-internal-subcommands.md)
- [Current hook scripts](/Users/anhlp/StudioProjects/alp-code/hooks)
- [Current adapter command renderer](/Users/anhlp/StudioProjects/alp-code/src/runtime/adapter-files.ts)
- [Current project init](/Users/anhlp/StudioProjects/alp-code/src/cli/commands/init.ts)
- [Current repair logic](/Users/anhlp/StudioProjects/alp-code/scripts/lib/state.cjs)

## Overview

- Priority: P1
- Status: pending
- Effort: 2 days
- Purpose: move three hooks into the binary while repairing long-lived project settings safely.

## Requirements

- Public contract: `alp hook session-boot`, `alp hook session-end`, `alp hook compact-record <pre|post> <claude|codex>`.
- Hook handlers preserve stdin/stdout, exit code, fail-open/fail-closed behavior and size bounds byte-for-byte where observable.
- Generated project config uses `layout.stableCommand`; runtime-managed temporary config uses a platform-tested command renderer.
- Legacy `.cjs` hooks remain shipped throughout v0.10.

## Files

- Create: `/Users/anhlp/StudioProjects/alp-code/src/cli/hook-entry.ts`.
- Create: `/Users/anhlp/StudioProjects/alp-code/src/runtime/hook-command.ts`.
- Create: `/Users/anhlp/StudioProjects/alp-code/test/cli/hook-entry.test.ts`.
- Create: `/Users/anhlp/StudioProjects/alp-code/test/runtime/hook-command.test.ts`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/src/cli/entry.ts`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/src/cli/commands/init.ts`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/src/runtime/adapter-files.ts`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/src/runtime/claude-adapter.ts`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/src/runtime/codex-adapter.ts`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/src/install/state.ts`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/scripts/lib/state.cjs`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/scripts/test-state.cjs`.
- Keep: `/Users/anhlp/StudioProjects/alp-code/hooks/session-boot.cjs`, `session-end.cjs`, `compact-record.cjs` through v0.10.

## Tasks

### Task 3.1 — Port handlers with parity fixtures

1. Capture golden outputs/exit codes for each existing hook across valid, malformed, missing and oversized input.
2. Write tests against the new callable handlers using the same fixtures.
3. Port session boot without importing registry, memory, Zod or full CLI.
4. Port session end using a static import of `execution-bridge`.
5. Port compact record with its 1 MiB stdin cap, 16 KiB line cap, whitelist and unconditional exit-zero contract.
6. Run old/new parity tests.

### Task 3.2 — Route hooks before full CLI

1. Add hook argument validation to lightweight entry.
2. Confirm hook path does not evaluate the full CLI sentinel.
3. Measure 30 warm runs and 10 cold launches; record p50/p95 and binary size.
4. Require session-boot p95 not worse than the agreed baseline; investigate before continuing if it regresses.

### Task 3.3 — Render commands per runtime/platform

1. Separate executable + argv model from rendered shell/config string.
2. POSIX and Claude Windows may use quoted absolute stable command after fixture verification.
3. Codex Windows must be tested on Windows for first-token quoting and paths containing spaces.
4. Evaluate measured candidates: absolute executable, PATH-resolved bare command, or explicit `cmd.exe` wrapper.
5. Record the working form; do not publish Windows support if none passes.

### Task 3.4 — Write new settings without losing user data

1. `alp init` writes the new contract using `stableCommand`.
2. Preserve backup/ownership-marker behavior.
3. If a generated file contains additional user fields/hooks, mutate only the ALP-owned hook entry.
4. Deinit removes only ALP-owned skill links and generated settings.

### Task 3.5 — Repair old projects

1. Extend shared `repairProjectHooks()`; do not add a second migration path.
2. Recognize `~/.alp/hooks/*.cjs`, absolute install hook paths and old Node executable paths.
3. Skip malformed JSON, absent projects, read-only projects and files without `$generatedBy: "alp init"`.
4. Make repeated runs byte-stable.
5. Test migration after binary update and after npm↔binary channel change.

### Task 3.6 — Real runtime gate

1. Install a v0.9-style project fixture.
2. Upgrade to host binary build and run state repair.
3. Open Claude manually; verify identity arrives before user turn 1.
4. Run delegated Claude/Codex execution; verify SessionStart/Stop and compact hooks.
5. Capture command/config artifacts for debugging evidence.

## Todo

- [ ] Three hook handlers have old/new parity coverage
- [ ] Hook path is import-light
- [ ] Runtime/platform command renderer is tested
- [ ] Generated config preserves unrelated user fields
- [ ] Repair is ownership-scoped and idempotent
- [ ] Old project turn-1 identity gate passes
- [ ] Legacy hook files retained for v0.10

## Success criteria

- Project initialized by v0.9 loads identity at turn 1 after upgrade.
- No hook in binary channel starts Node or executes a `.cjs` file.
- Hook failure behavior and output remain compatible.

## Risks and security

- Never rewrite config without the ALP ownership marker.
- Never interpolate payload data into command strings.
- Hook handlers must retain input bounds and avoid logging sensitive malformed payload contents.

## Next

- NB-4 packages the binary and external assets; hook deletion is deferred to v0.11.

