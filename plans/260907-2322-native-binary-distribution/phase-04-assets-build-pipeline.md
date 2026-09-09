# Phase NB-4 — Assets and Build Pipeline

## Context links

- [Master plan](./plan.md)
- [NB-0 compiler decision](./phase-00-bun-compatibility-probes.md)
- [Release spike](./research/spike-bun-vs-sea.md)
- [Current pack script](/Users/anhlp/StudioProjects/alp-code/scripts/pack-release.cjs)
- [Current release manifest](/Users/anhlp/StudioProjects/alp-code/scripts/lib/release-manifest.cjs)

## Overview

- Priority: P1
- Status: pending
- Effort: 1.5 days
- Purpose: produce deterministic platform archives containing the native executable and filesystem assets required at runtime.

## Artifact contract

```text
alp-code-vX.Y.Z-<target>.tar.gz
  bin/alp                 # alp.exe on Windows
  skills/
  scaffold/
  LICENSE
  install-manifest.json  # schema, version, target, compiler
```

Targets:

- `darwin-arm64`
- `darwin-x64`
- `linux-x64-gnu`
- `linux-arm64-gnu`
- `windows-x64`

`SHA256SUMS` is emitted beside archives. It detects corruption/mix-up; it is not claimed as independent publisher authentication.

## Files

- Create: `/Users/anhlp/StudioProjects/alp-code/.bun-version` — exact compiler version selected by NB-0.
- Create: `/Users/anhlp/StudioProjects/alp-code/scripts/lib/binary-targets.cjs` — one target/name/platform mapping.
- Create: `/Users/anhlp/StudioProjects/alp-code/scripts/build-binary.cjs` — compile, stage, archive and checksum.
- Create: `/Users/anhlp/StudioProjects/alp-code/scripts/test-binary-build.cjs`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/scripts/lib/release-manifest.cjs` — platform archive contract.
- Modify: `/Users/anhlp/StudioProjects/alp-code/scripts/pack-release.cjs` — build npm wrapper plus five archives.
- Modify: `/Users/anhlp/StudioProjects/alp-code/scripts/test-pack-release.cjs`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/package.json` — `build:binary`, `test:binary-build` scripts and direct build dependencies if needed.
- Modify: `/Users/anhlp/StudioProjects/alp-code/.gitignore` — generated binary/archive output only.

## Tasks

### Task 4.1 — Define target and manifest contracts

1. Write failing tests for five target mappings, executable filename and archive filename.
2. Define `install-manifest.json` schema with exact app version, target and compiler version.
3. Reject unknown OS/arch/libc rather than selecting a “closest” artifact.
4. Keep target mapping shared by builder, installers, updater and npm wrapper.

### Task 4.2 — Build reproducibly

1. Assert local Bun version equals `.bun-version`; no floating `bun 1.4` range.
2. Compile only `/Users/anhlp/StudioProjects/alp-code/src/cli/entry.ts`.
3. Inject version/compiler metadata at build time.
4. Start with `--minify`; enable `--bytecode` only when the same artifact benchmark proves a material p95 improvement.
5. Save bundler module metadata and fail when a required local module is externalized.
6. Normalize archive root/layout, timestamps and permissions where the platform tooling allows.

### Task 4.3 — Stage external assets

1. Copy `skills/`, `scaffold/`, `LICENSE` and generated manifest into each staging root.
2. Do not embed or duplicate scaffold inside the binary.
3. Verify archives contain no `src/`, `dist/`, `node_modules/`, tests, `.git` or user state.
4. Verify Unix executable mode and Windows `.exe` name.

### Task 4.4 — Checksum and structure validation

1. Generate SHA-256 after all archives are finalized.
2. Parse `SHA256SUMS` in tests; recompute every digest.
3. Validate archive entries before extraction: no absolute path, `..`, device entry or escaping symlink.
4. Extract each archive to an isolated directory and validate manifest/asset structure.

### Task 4.5 — Host smoke and release-source binding

1. Run host-compatible archive `--version`, help, doctor fixture and state fixture outside the repo.
2. Assert reported version equals package version and archive manifest.
3. `pack-release.cjs` must build from a clean tree whose HEAD/tag/version agree; no artifact from uncommitted mixed source.
4. Keep `cut-release.cjs` responsible for source version/tag only; artifact build remains a separately verifiable step.

## Todo

- [ ] Exact compiler version pinned
- [ ] Five target mappings share one source
- [ ] Archive manifest contract tested
- [ ] No Bun-only embedded assets
- [ ] SHA256SUMS recomputed in tests
- [ ] Host archive runs outside repo
- [ ] Build is bound to clean tagged source

## Success criteria

- One command emits five archives plus checksums.
- Same version/source/compiler inputs yield equivalent manifests and payload layout.
- Host artifact has no runtime dependency on repo, Node, Bun or npm.

## Risks and security

- Checksums downloaded from the same release are integrity checks, not signing; do not document them as signature verification.
- Archive traversal validation must occur before extraction in every consumer, not only in build tests.
- Compiler pin changes require rerunning NB-0 compatibility probes.

## Next

- NB-5 consumes only the manifest/target/archive APIs defined here.

