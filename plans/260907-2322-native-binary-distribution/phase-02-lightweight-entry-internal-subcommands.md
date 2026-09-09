# Phase NB-2 — Lightweight Entry and Internal Subcommands

## Context links

- [Master plan](./plan.md)
- [NB-1 layout contract](./phase-01-install-layout-static-boundary.md)
- [Current CLI entry](/Users/anhlp/StudioProjects/alp-code/src/cli/alp.ts)
- [Current update checker](/Users/anhlp/StudioProjects/alp-code/src/cli/update-check.ts)
- [Current supervisor](/Users/anhlp/StudioProjects/alp-code/src/backend/local-supervisor.ts)

## Overview

- Priority: P1
- Status: pending
- Effort: 1.5 days
- Purpose: create a small executable entry that routes latency-sensitive/internal commands without evaluating the full CLI graph.

## Architecture

```text
entry.ts
  parse minimal argv
  ├─ --version
  ├─ hook ...
  ├─ __internal ensure-state
  ├─ __internal update-check
  ├─ __internal supervisor <spec>
  └─ lazy import alp.ts → normal CLI
```

Only `selfExecutable` may launch `__internal` commands. Internal commands stay undocumented in public help and validate their inputs strictly.

## Files

- Create: `/Users/anhlp/StudioProjects/alp-code/src/cli/entry.ts` — compile entry and fast dispatcher.
- Create: `/Users/anhlp/StudioProjects/alp-code/src/cli/internal.ts` — internal command parser/dispatch.
- Create: `/Users/anhlp/StudioProjects/alp-code/test/cli/entry.test.ts`.
- Create: `/Users/anhlp/StudioProjects/alp-code/test/cli/internal.test.ts`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/src/cli/alp.ts` — full CLI only, no standalone bootstrap assumption.
- Modify: `/Users/anhlp/StudioProjects/alp-code/src/cli/update-check.ts` — respawn `__internal update-check`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/src/backend/local-process-backend.ts` — respawn `__internal supervisor`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/src/backend/local-supervisor.ts` — export callable handler.
- Modify: `/Users/anhlp/StudioProjects/alp-code/scripts/alp.cjs` — Node/dev shim delegates to the same entry contract.

## Tasks

### Task 2.1 — Prove fast paths are lazy

1. Add a test-only sentinel module to the full CLI graph.
2. Assert `--version`, hook placeholder and internal parser do not evaluate the sentinel.
3. Assert a normal command does lazy-load it.
4. Run tests and confirm the initial implementation fails before splitting entry.

### Task 2.2 — Implement minimal entry

1. Parse only enough argv to identify fast/internal commands.
2. Print build-time version without state read, network call or background process.
3. Lazy-import full `alp.ts` for normal commands.
4. Ensure normal command output/exit codes match the existing CLI tests.

### Task 2.3 — Internal supervisor and update checker

1. Replace `process.execPath + local-supervisor.js` with `selfExecutable __internal supervisor <spec>`.
2. Replace update worker script path with `selfExecutable __internal update-check`.
3. Preserve detached/unref/stdio behavior verified in NB-0.
4. Validate supervisor spec ownership, mode, schema and bounded file size before use.
5. Add parent-exits/child-completes integration tests.

### Task 2.4 — Internal state bootstrap

1. Add `__internal ensure-state` backed by the static NB-1 state module.
2. Normal CLI invocation checks install record freshness before loading full dependencies.
3. Fast `--version` and hook execution must not run full state bootstrap.
4. Installer/updater may invoke exact new executable with this subcommand in NB-5.

### Task 2.5 — Native skeleton smoke

1. Compile `src/cli/entry.ts` for host target.
2. Run `--version`, help, one normal read-only command and all internal commands with fixtures.
3. Inspect child process command lines; no `.cjs` runtime path may be passed to the binary.

## Todo

- [ ] Lightweight entry exists
- [ ] Full CLI is lazy-loaded
- [ ] Version path has no state/network side effect
- [ ] Supervisor/update-check/state use internal subcommands
- [ ] Host native skeleton smoke passes

## Success criteria

- Fast-path import test proves full CLI graph is not evaluated.
- No binary self-spawn treats the executable as a Node interpreter.
- CLI parity tests retain output and exit codes.

## Risks and security

- Internal commands are not authorization boundaries; still validate file inputs because paths can be user-controlled.
- Detached supervisor must not inherit unrelated sensitive environment beyond the existing execution contract.
- Do not use `eval`, shell parsing or command-string concatenation for internal respawn.

## Next

- NB-3 implements real hook handlers on the fast path.

