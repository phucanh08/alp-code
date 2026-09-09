# Bun compatibility gate — measured result

- Date: 2026-09-08
- Host: macOS 25.5.0, Apple arm64; Node x64 under Rosetta
- Compiler: Bun `1.4.2+744846f84` (pin: `.bun-version`)

## Host runtime probes

Command:

```console
node scripts/test-bun-compat.cjs
PASS bun compatibility probe harness
```

| Capability | Expected | Observed | Result | Workaround |
|---|---|---|---|---|
| `spawnSync` | exact stdout/stderr bytes and exit status | preserved; explicit exit `23` | pass | none |
| asynchronous `spawn` | exact stdout/stderr bytes | preserved | pass | none |
| `execFile` | executable launches without shell | preserved output and exit | pass | none |
| stdio | inherit, ignored stdin and 1 MiB piped stdin | all completed; input byte-identical | pass | none |
| detached + `unref` | launcher exits before child marker | child completed after launcher exit | pass | none |
| SIGINT forwarding | child receives signal, conventional status | marker written, exit `130` | pass | none |
| SIGTERM forwarding | child receives signal, conventional status | marker written, exit `143` | pass | none |
| atomic file replacement | temp file renamed into place | complete content observed | pass | none |
| private modes | file `0600`, directory `0700` | exact modes on POSIX | pass | none |
| symlink replacement | rename new symlink over old without unlink gap | link resolves to v2 | pass | none |
| symlink invocation | executable remains self-addressable | `process.execPath` resolves to physical executable | pass | preserve a separate stable command in layout |
| running executable rename | POSIX executable can be renamed and restored | rename and restore succeeded | pass | Windows remains a target-host gate |
| state isolation | probe must not create default ALP state | no `.alp` under isolated HOME | pass | none |

Two Bun-specific observations affect the implementation contract:

1. A compiled program reports `process.argv` as `["bun", "/$bunfs/root/<entry>", ...userArgs]`; the lightweight entry must consume user arguments after the bundled-entry slot.
2. An unresolved Promise alone does not keep a compiled Bun process alive. Detached/signal workers need an active child, timer or I/O handle.

## Cross-compile structure probe

All targets were produced from the pinned compiler on the host:

| Bun target | Release target | Observed format | Size | Result |
|---|---|---|---:|---|
| `bun-darwin-arm64` | `darwin-arm64` | Mach-O 64-bit arm64 | 60 MiB | pass |
| `bun-darwin-x64` | `darwin-x64` | Mach-O 64-bit x86_64 | 66 MiB | pass |
| `bun-linux-x64` | `linux-x64-gnu` | ELF 64-bit x86-64, interpreter `/lib64/ld-linux-x86-64.so.2` | 92 MiB | pass |
| `bun-linux-arm64` | `linux-arm64-gnu` | ELF 64-bit aarch64, interpreter `/lib/ld-linux-aarch64.so.1` | 92 MiB | pass |
| `bun-windows-x64` | `windows-x64` | PE32+ console x86-64 | 82 MiB | pass |

Cross-build success is structure evidence only. Linux and Windows runtime support remains gated by NB-7 target-host execution.

## Decision

**Choose Bun for v0.10.** Every blocking host primitive passed and all five scoped target binaries were produced with the expected format and architecture. No Bun blocker requires the SEA fallback.

The Rosetta host exposed one tooling caveat: npm running under x64 filters Bun's arm64 optional package even though the physical machine is arm64. The probe therefore pins the version independently and accepts an exact `BUN_BINARY`, a local matching package binary, or a matching Bun on `PATH`; it always rejects a version mismatch before compiling.
