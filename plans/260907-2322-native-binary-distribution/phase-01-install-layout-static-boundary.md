# Phase NB-1 — Install Layout and Static Runtime Boundary

## Context links

- [Master plan](./plan.md)
- [NB-0](./phase-00-bun-compatibility-probes.md)
- [Current install paths](/Users/anhlp/StudioProjects/alp-code/scripts/lib/install-paths.cjs)
- [Current state bootstrap](/Users/anhlp/StudioProjects/alp-code/scripts/lib/state.cjs)
- [Current CLI composition](/Users/anhlp/StudioProjects/alp-code/src/cli/alp.ts)

## Overview

- Priority: P1
- Status: pending
- Effort: 2 days
- Purpose: remove `repoRoot` ambiguity and make every runtime dependency statically bundleable before building the native entry.

## Architecture

Introduce one immutable layout contract:

```ts
interface InstallLayout {
  channel: "binary" | "npm" | "dev";
  version: string;
  selfExecutable: string;   // internal respawn only
  stableCommand: string;    // long-lived settings only
  installRoot: string;      // immutable version/package root
  assetRoot: string;        // skills + scaffold
}
```

Resolution precedence: explicit injected test/dev overrides → npm-wrapper handoff metadata → compiled executable layout → dev clone. Every detected layout validates its manifest/assets before use.

## Files

- Create: `/Users/anhlp/StudioProjects/alp-code/src/build-info.ts` — build-time version/compiler constants.
- Create: `/Users/anhlp/StudioProjects/alp-code/src/install-layout.ts` — layout detection/validation.
- Create: `/Users/anhlp/StudioProjects/alp-code/src/install/paths.ts` — state/install path primitives used by binary.
- Create: `/Users/anhlp/StudioProjects/alp-code/src/install/state.ts` — bundleable `ensureState` core.
- Create: `/Users/anhlp/StudioProjects/alp-code/src/install/config.ts` — bundleable delegation config parser.
- Create: `/Users/anhlp/StudioProjects/alp-code/src/install/semver.ts` — shared semver implementation.
- Create: `/Users/anhlp/StudioProjects/alp-code/test/cli/install-layout.test.ts`.
- Create: `/Users/anhlp/StudioProjects/alp-code/test/install/state.test.ts`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/src/cli/alp.ts`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/src/cli/commands/delegate.ts`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/src/runtime/adapter-files.ts`.
- Modify: `/Users/anhlp/StudioProjects/alp-code/scripts/lib/install-paths.cjs` — legacy wrapper around shared compiled behavior where practical.
- Modify: `/Users/anhlp/StudioProjects/alp-code/scripts/lib/state.cjs` — legacy wrapper retained for v0.10 migration.

## Tasks

### Task 1.1 — Test the layout contract first

1. Write failing cases for binary version directory, `current` symlink, npm handoff and dev clone.
2. Assert `selfExecutable !== stableCommand` where versioned binary is reached through a stable link.
3. Assert missing manifest/skills/scaffold fails with actionable error.
4. Assert paths containing spaces remain exact.
5. Run the focused test and confirm failures describe the absent contract.

### Task 1.2 — Implement build info and layout

1. Replace runtime `package.json` version reads with injected build constant.
2. Implement layout without relying on `__dirname` inside the compiled binary.
3. Keep environment overrides injectable for tests; do not silently accept invalid roots.
4. Pass `assetRoot` explicitly to skill discovery and init/deinit.
5. Run focused tests to green.

### Task 1.3 — Move runtime CJS dependencies into static TypeScript imports

1. Port `semver-lite.cjs` and delegation config behavior with parity tests.
2. Port state/install-path behavior required at runtime.
3. Replace `createRequire(join(...))` in delegate/update paths.
4. Inventory all production `createRequire`, dynamic `require(path...)` and `process.execPath + *.cjs`; each must be removed or documented as dev-only.
5. Use bundler metafile/module list as the closure gate; do not use output size as a proxy.

### Task 1.4 — Fix state/data roots while preserving semantics

1. Change delegation composition from `<install>/memory` to `memoryRoot()` under `~/.alp`.
2. Keep execution/delegation installed-state stable across versioned roots.
3. Ensure `runtimeSkillRoots()` uses `layout.assetRoot`, not an ambient `ALP_REPO_ROOT` coincidence.
4. Add regression tests for binary layout update from version A to B.

### Task 1.5 — Preserve legacy Node channels

1. Keep `scripts/alp.cjs` usable for dev and v0.10 compatibility.
2. Make wrappers call compiled shared modules rather than duplicate new business logic.
3. Verify dev clone still builds before state bootstrap when `dist/` is absent.

## Todo

- [ ] `InstallLayout` covers binary/npm/dev
- [ ] Version no longer requires runtime `package.json`
- [ ] Runtime code has no path-built production require
- [ ] Delegation reads `~/.alp/memory`
- [ ] Runtime skill roots come from `assetRoot`
- [ ] Legacy Node/dev path remains covered

## Success criteria

- Static analysis finds no production dynamic require from installation paths.
- All paths used for respawn/settings/assets have one documented owner.
- Updating versioned install root does not change user state paths.

## Risks and security

- Never trust npm-wrapper environment metadata without validating executable/install root relationship.
- Resolve symlinks only where physical identity is required; preserve logical stable path for config.
- Layout validation must reject directory traversal and foreign manifests.

## Next

- NB-2 consumes `InstallLayout`; later phases must not rediscover paths independently.

