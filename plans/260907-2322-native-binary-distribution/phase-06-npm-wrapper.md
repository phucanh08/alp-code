# Phase NB-6 — npm Wrapper

## Context links

- [Master plan](./plan.md)
- [NB-1 layout handoff](./phase-01-install-layout-static-boundary.md)
- [NB-4 artifact contract](./phase-04-assets-build-pipeline.md)
- [NB-5 install lifecycle](./phase-05-install-update-uninstall.md)
- [Current package metadata](/Users/anhlp/StudioProjects/alp-code/package.json)

## Overview

- Priority: P1
- Status: pending
- Effort: 1-1.5 days
- Purpose: keep `npm i -g alp-code` as a valid channel while making npm own only a small launcher/downloader, not ALP runtime code.

## Architecture

- Published npm package contains a Node wrapper because npm users necessarily have Node.
- Wrapper resolves the archive matching its own exact package version; never `/latest`.
- It downloads/extracts the full platform archive—binary, skills and scaffold—into a per-user versioned cache, not an assumed-writable global package directory.
- Wrapper passes validated npm channel metadata and its stable command path to the native executable.
- `--ignore-scripts` skips eager download but first invocation performs the same locked, atomic install.

## Files

- Create: `/Users/anhlp/StudioProjects/alp-code/npm-wrapper/package.json`.
- Create: `/Users/anhlp/StudioProjects/alp-code/npm-wrapper/install.cjs`.
- Create: `/Users/anhlp/StudioProjects/alp-code/npm-wrapper/bin/alp.cjs`.
- Create: `/Users/anhlp/StudioProjects/alp-code/npm-wrapper/lib/resolve-target.cjs`.
- Create: `/Users/anhlp/StudioProjects/alp-code/npm-wrapper/lib/install-payload.cjs`.
- Create: `/Users/anhlp/StudioProjects/alp-code/scripts/test-npm-wrapper.cjs`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/package.json` — development package scripts; do not accidentally publish the full repo package.
- Modify: `/Users/anhlp/StudioProjects/alp-code/scripts/pack-release.cjs` — inject exact version and pack `npm-wrapper/`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/scripts/lib/release-manifest.cjs`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/scripts/test-pack-release.cjs`.

## Tasks

### Task 6.1 — Define package ownership and version binding

1. Write tests proving npm package version maps to release tag `v<same-version>`.
2. Make package `bin` point only to the wrapper launcher.
3. Ensure npm tarball contains no `dist/`, source tree, legacy runtime scripts or bundled dependency tree.
4. Verify package name/version/license/repository metadata are synchronized at pack time.

### Task 6.2 — Download the full payload safely

1. Reuse target names and archive contract from NB-4; do not duplicate mapping by hand.
2. Download archive and checksums for the exact package version.
3. Validate checksum, archive entries and manifest before cache activation.
4. Store under a per-user immutable path such as `~/.alp-code/npm/versions/<version>/<target>`.
5. Use a lock and unique staging directory for concurrent first runs.

### Task 6.3 — Wrapper execution handoff

1. Resolve the wrapper’s stable npm command path before launching native ALP.
2. Pass explicit npm-channel/install-layout metadata; native code validates it against manifest/version.
3. Spawn the native executable with argv/stdin/stdout/signals preserved.
4. Return the native process exit code exactly.
5. Document that npm channel may pay Node wrapper startup cost; the `<40 ms` gate applies to direct binary channel.

### Task 6.4 — `--ignore-scripts` and network failure

1. Test installation with lifecycle scripts disabled.
2. First invocation installs payload once and then executes it.
3. Interrupted first install leaves no active partial payload.
4. Offline failure names the exact URL/version and offers binary installer remediation.
5. A previously complete cached payload remains runnable during release-service outage.

### Task 6.5 — npm update/uninstall and channel transition

1. `alp update` in npm channel uses `npm install -g alp-code@<version>`, not binary `current` mutation.
2. `alp uninstall` lets npm remove its package and removes only wrapper-owned cached versions.
3. First invocation after npm↔binary transition repairs project hooks to the new stable command.
4. Verify a foreign `alp` command/cache directory is never overwritten or deleted.

## Todo

- [ ] npm package is wrapper-only
- [ ] Payload release version exactly equals package version
- [ ] Full archive, including skills/scaffold, is installed
- [ ] Cache is per-user, immutable and concurrency-safe
- [ ] `--ignore-scripts` first run works
- [ ] Exit code/stdin/stdout/signals preserved
- [ ] npm update/uninstall ownership remains correct

## Success criteria

- `npm i -g alp-code` followed by `alp --version` runs the exact matching native release.
- Ignored postinstall and interrupted download recover on the next invocation.
- npm channel never misidentifies its cached binary as binary channel.

## Risks and security

- Environment handoff is untrusted input until checked against wrapper path and install manifest.
- Do not execute downloaded payload before checksum and manifest validation.
- Avoid downloading “latest” from an older npm wrapper; version mismatch must fail closed.

## Next

- NB-7 validates npm and direct binary channels in the release matrix.

