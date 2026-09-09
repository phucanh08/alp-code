# Phase NB-0 — Bun Compatibility Probes

## Context links

- [Master plan](./plan.md)
- [Existing Bun vs SEA spike](./research/spike-bun-vs-sea.md)
- [Current CLI entry](/Users/anhlp/StudioProjects/alp-code/src/cli/alp.ts)
- [Current process backend](/Users/anhlp/StudioProjects/alp-code/src/backend/local-process-backend.ts)

## Overview

- Priority: blocking
- Status: pending
- Effort: 1-1.5 days
- Purpose: quyết định Bun/SEA bằng isolated runtime probes. Không dùng full ALP binary làm gate khi hook/supervisor contract chưa được refactor.

## Key insights

- Compile `src/cli/alp.ts` nguyên trạng chứng minh bundler nhận code, không chứng minh ALP runtime đúng.
- Full `alp delegate` hiện chắc chắn đụng `process.execPath + script.cjs`; trong standalone executable, đó là self-invocation sai contract.
- Bun risk surface gồm child processes, stdio, detach/signal, filesystem semantics, `process.execPath`, symlink path và platform target—not only startup.

## Files

- Create: `/Users/anhlp/StudioProjects/alp-code/scripts/spike-bun-compat.cjs` — build/run probe matrix.
- Create: `/Users/anhlp/StudioProjects/alp-code/test/fixtures/binary-compat/probe.ts` — standalone probe entry.
- Create: `/Users/anhlp/StudioProjects/alp-code/test/fixtures/binary-compat/child.ts` — child/stdio/signal fixture.
- Create: `/Users/anhlp/StudioProjects/alp-code/plans/260907-2322-native-binary-distribution/research/bun-compat.md` — measured decision record.
- Modify: `/Users/anhlp/StudioProjects/alp-code/package.json` — add non-release spike command only if retained after gate.

## Tasks

### Task 0.1 — Pin the probe environment

1. Record Bun exact version, commit hash if available, OS, architecture and filesystem.
2. Make the probe abort when invoked with another Bun version.
3. Keep generated executables under an ignored temporary/build directory.
4. Run probe help and verify it does not modify `~/.alp`.

### Task 0.2 — Child process and stdio probes

1. Add assertions for `spawn`, `spawnSync`, `execFile`, exit code and stderr/stdout byte preservation.
2. Test `stdio: inherit`, pipe, ignored stdin and large stdin.
3. Test detached child + `unref`; parent must exit while child writes a completion marker.
4. Test SIGINT/SIGTERM forwarding and exit 130 behavior on POSIX.
5. Run native-host target; record exact outputs and failures.

### Task 0.3 — Filesystem and executable-path probes

1. Test temp-file → rename → chmod `0600/0700` on POSIX.
2. Test atomic replacement of a symlink without pre-unlinking it.
3. Invoke executable through a symlink and record `process.execPath`, argv and resolved path.
4. Test deleting/renaming a running executable on the host platform without assuming behavior on other OSes.

### Task 0.4 — Cross-compile structure probe

1. Build darwin-arm64, darwin-x64, linux-x64 glibc, linux-arm64 glibc and windows-x64.
2. Verify file format/architecture for all outputs.
3. Run only host-compatible output here. Runtime validation belongs to NB-7.

### Task 0.5 — Decision record

1. Write one row per capability: command, expected, observed, pass/fail, workaround.
2. Classify failures: ALP refactorable, Bun blocker, unknown-needs-target-host.
3. Choose Bun only when all blocking host probes pass and cross-target builds are produced.
4. If Bun fails: mark NB-4 compiler implementation as SEA; keep NB-1/2/3 contracts compiler-neutral.

## Todo

- [ ] Exact Bun version pinned for probes
- [ ] Child/stdio/detach/signal probes executed
- [ ] Filesystem/process-path probes executed
- [ ] Five cross-target outputs produced
- [ ] `research/bun-compat.md` records evidence and compiler decision

## Success criteria

- Gate does not depend on legacy hook/supervisor scripts being runnable by the binary.
- Every blocker has reproducible command and captured result.
- Compiler choice is explicit; no “seems compatible” conclusion.

## Risks and security

- Probe must isolate HOME/state paths and never rewrite real install records.
- Detached child cleanup must be deterministic; no orphan process after probe.
- Cross-build success is not counted as runtime support.

## Next

- Pass → NB-1.
- Bun blocker → revise only compiler-specific NB-4/NB-7 details for SEA before continuing.

