# Layered ALP Settings Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add layered global/project JSON settings for mode-to-agent model routing and move the default application checkout from `~/.alp-code` to `~/.alp/app` with safe migration.

**Architecture:** Keep the shipped mode profiles as immutable compiled defaults, then parse and deep-merge `~/.alp/setting.json` with the nearest project `.alp/setting.local.json`. Resolve one immutable launch profile before policy preparation, snapshot its model/effort/runtime into `policy.json`, and make adapters consume that snapshot. Installer/bootstrap code owns initial generation and legacy migration; user values are never overwritten.

**Tech Stack:** TypeScript 5.9, Node.js filesystem APIs, Zod 4, Vitest 3, CommonJS maintenance scripts, Bash, Windows PowerShell.

---

Use `@superpowers:test-driven-development` for every production-code task, `@superpowers:systematic-debugging` for unexpected failures, and `@superpowers:verification-before-completion` before the final completion claim.

### Task 1: Define and validate the JSON settings contract

**Files:**
- Create: `src/settings/types.ts`
- Create: `src/settings/settings.ts`
- Create: `schemas/setting.schema.json`
- Create: `test/settings/settings.test.ts`
- Modify: `src/agents/modes.ts`

**Step 1: Write failing contract tests**

Cover the complete generated document, a partial local overlay, and strict rejection of unknown keys, modes, agents, models, and efforts:

```ts
import { describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import {
  createDefaultSettingsDocument,
  parseSettingsDocument,
} from "../../src/settings/settings";

describe("settings document", () => {
  const agents = agentRegistry.list().map((agent) => agent.id);

  it("renders all shipped modes and agents with the public agent-teams spelling", () => {
    const document = createDefaultSettingsDocument();
    expect(document.mode).toBe("medium");
    expect(Object.keys(document.modes!)).toEqual(["low", "medium", "high", "ultra", "puck"]);
    expect(Object.keys(document.modes!.high!["agent-teams"]!).sort()).toEqual([...agents].sort());
  });

  it("accepts a field-level local override", () => {
    expect(parseSettingsDocument({
      modes: { high: { "agent-teams": { main: { model: "claude-opus-5" } } } },
    }, "/project/.alp/setting.local.json")).toMatchObject({
      modes: { high: { "agent-teams": { main: { model: "claude-opus-5" } } } },
    });
  });

  it.each([
    [{ surprise: true }, "surprise"],
    [{ mode: "smart" }, "mode"],
    [{ modes: { high: { "agent-teams": { ghost: { model: "gpt-5.6-sol" } } } } }, "ghost"],
    [{ modes: { high: { "agent-teams": { main: { model: "gpt-unknown" } } } } }, "model"],
    [{ modes: { high: { "agent-teams": { main: { reasoningEffort: "deep" } } } } }, "reasoningEffort"],
  ])("rejects invalid settings %# with a source-aware error", (value, field) => {
    expect(() => parseSettingsDocument(value, "/tmp/setting.json")).toThrow(
      new RegExp(`/tmp/setting\\.json.*${field}`, "s"),
    );
  });
});
```

**Step 2: Run the focused test and verify RED**

Run: `npx vitest run test/settings/settings.test.ts`

Expected: FAIL because `src/settings/settings.ts` does not exist.

**Step 3: Add settings types and validation**

Define public document and normalized effective types:

```ts
export interface AgentTeamOverride {
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
}

export interface ModeSettingsOverride {
  readonly "agent-teams"?: Readonly<Record<AgentId, AgentTeamOverride>>;
}

export interface SettingsDocument {
  readonly $schema?: string;
  readonly mode?: ModeId;
  readonly modes?: Readonly<Partial<Record<ModeId, ModeSettingsOverride>>>;
}

export interface EffectiveSettings {
  readonly mode: ModeId;
  readonly modes: Readonly<Record<ModeId, ModeProfile>>;
}

export interface ResolvedLaunchProfile {
  readonly mode: ModeId;
  readonly agent: AgentId;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly runtime: RuntimeId;
}
```

Build a strict Zod schema from `MODE_IDS`, `agentRegistry.list()`, `MODEL_RUNTIMES`, and the effort
union. Format failures as `invalid settings at <source>: <property.path> <message>`. Export
`SETTINGS_SCHEMA_URL`, `createDefaultSettingsDocument()`, and `parseSettingsDocument()`.

The generated document must serialize every compiled `MODE_PROFILES[mode].roles[agent]` entry as
`modes[mode]["agent-teams"][agent]`, while keeping internal TypeScript identifiers camel-cased.

**Step 4: Add the editor JSON Schema**

Create a draft-2020-12 schema with `additionalProperties: false` at every object level, enums for
the five modes, eight agents, known models, and six effort values. Keep each agent entry partial so
the same public schema validates `setting.local.json`; separately test that
`createDefaultSettingsDocument()` emits both `model` and `reasoningEffort` for every shipped entry.

**Step 5: Run tests and typecheck**

Run: `npx vitest run test/settings/settings.test.ts test/agents/modes.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/settings src/agents/modes.ts schemas/setting.schema.json test/settings/settings.test.ts
git commit -m "feat(settings): define strict agent-team config schema"
```

### Task 2: Deep-merge settings and resolve immutable launch profiles

**Files:**
- Modify: `src/settings/settings.ts`
- Modify: `test/settings/settings.test.ts`
- Modify: `test/agents/modes.test.ts`

**Step 1: Write failing merge and resolution tests**

```ts
it("merges local model and global effort independently", () => {
  const effective = mergeSettings(
    createDefaultSettingsDocument(),
    parseSettingsDocument({
      mode: "high",
      modes: { high: { "agent-teams": { main: { reasoningEffort: "max" } } } },
    }, "~/.alp/setting.json"),
    parseSettingsDocument({
      modes: { high: { "agent-teams": { main: { model: "claude-opus-5" } } } },
    }, "/project/.alp/setting.local.json"),
  );

  expect(effective.mode).toBe("high");
  expect(effective.modes.high.roles.main).toEqual({
    model: "claude-opus-5",
    reasoningEffort: "max",
  });
});

it("derives runtime from the effective model", () => {
  const profile = resolveLaunchProfile(effectiveFixture, agentRegistry.get("main"), "high");
  expect(profile).toEqual({
    mode: "high",
    agent: "main",
    model: "claude-opus-5",
    reasoningEffort: "max",
    runtime: "claude",
  });
});
```

Also test global-only inheritance, local `mode` winning global `mode`, and a custom future agent
falling back to its `AgentDefinition` on the selected mode's home runtime.

**Step 2: Run the focused test and verify RED**

Run: `npx vitest run test/settings/settings.test.ts`

Expected: FAIL because merge/resolution exports do not exist.

**Step 3: Implement field-level merge and resolver**

Implement `mergeSettings(defaults, global, local)` by iterating known modes and registered agents.
For each field, use local → global → default. Deep-freeze the returned effective settings.

Implement:

```ts
export function resolveLaunchProfile(
  settings: EffectiveSettings,
  definition: AgentDefinition<unknown>,
  mode: ModeId,
): ResolvedLaunchProfile {
  const configured = settings.modes[mode].roles[definition.id];
  const model = configured?.model ?? modelForMode(definition, mode);
  const reasoningEffort = configured?.reasoningEffort ?? reasoningEffortForMode(definition, mode);
  return Object.freeze({
    mode,
    agent: definition.id,
    model,
    reasoningEffort,
    runtime: runtimeForModel(model),
  });
}
```

Do not add prefix-based runtime inference or custom mode creation.

**Step 4: Run tests**

Run: `npx vitest run test/settings/settings.test.ts test/agents/modes.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/settings/settings.ts test/settings/settings.test.ts test/agents/modes.test.ts
git commit -m "feat(settings): merge layered agent launch profiles"
```

### Task 3: Add the global/project settings store and atomic writes

**Files:**
- Create: `src/settings/settings-store.ts`
- Create: `test/settings/settings-store.test.ts`
- Reuse: `test/support/file-mode.ts`

**Step 1: Write failing filesystem tests**

Test these contracts in temporary roots:

```ts
it("loads global settings and the nearest ancestor local override", async () => {
  await writeJson(globalFile, { mode: "medium", modes: {} });
  await writeJson(join(project, ".alp", "setting.local.json"), { mode: "ultra" });
  const store = new FileSettingsStore({ home, cwd: join(project, "packages", "api") });
  const loaded = await store.load();
  expect(loaded.settings.mode).toBe("ultra");
  expect(loaded.localFile).toBe(join(project, ".alp", "setting.local.json"));
});

it("updates only global mode atomically", async () => {
  await writeJson(globalFile, customGlobalDocument);
  await new FileSettingsStore({ home, cwd: project }).writeGlobalMode("puck");
  expect(JSON.parse(await readFile(globalFile, "utf8"))).toEqual({
    ...customGlobalDocument,
    mode: "puck",
  });
  await expectPosixMode(globalFile, 0o600);
  expect(await readdir(join(home, ".alp"))).toEqual(["setting.json"]);
});
```

Also test missing files, a malformed local file naming its source, no overwrite on malformed
global JSON, and nearest-local selection when nested project configs exist.

**Step 2: Run the focused test and verify RED**

Run: `npx vitest run test/settings/settings-store.test.ts`

Expected: FAIL because `FileSettingsStore` does not exist.

**Step 3: Implement the store**

Expose:

```ts
export interface LoadedSettings {
  readonly settings: EffectiveSettings;
  readonly globalDocument: SettingsDocument | null;
  readonly globalFile: string;
  readonly localFile: string | null;
}

export class FileSettingsStore {
  async load(): Promise<LoadedSettings>;
  async writeGlobalMode(mode: ModeId): Promise<void>;
  async ensureGlobalSettings(): Promise<{ created: boolean; added: readonly string[] }>;
}
```

Default the global path to `<HOME>/.alp/setting.json`. Find local settings by walking from `cwd`
to the filesystem root and choosing the first `.alp/setting.local.json`. Treat only `ENOENT` as
absence.

Use the existing random-temp + exclusive-create + chmod + rename pattern. `ensureGlobalSettings()`
must merge missing defaults into the user document but preserve every existing leaf exactly.

**Step 4: Run tests and typecheck**

Run: `npx vitest run test/settings/settings-store.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/settings/settings-store.ts test/settings/settings-store.test.ts
git commit -m "feat(settings): load global and project config layers"
```

### Task 4: Snapshot the resolved launch profile into execution policy

**Files:**
- Modify: `src/execution/types.ts`
- Modify: `src/execution/execution-policy.ts`
- Modify: `src/execution/execution-service.ts`
- Modify: `src/runtime/runtime-adapter.ts`
- Modify: `src/runtime/claude-adapter.ts`
- Modify: `src/runtime/codex-adapter.ts`
- Modify: `test/support/execution-fixture.ts`
- Modify: `test/agents/modes.test.ts`
- Modify: `test/execution/execution-service.test.ts`
- Modify: `test/runtime/runtime-adapters.test.ts`

**Step 1: Write failing policy tests**

```ts
it("snapshots the effective launch profile and hashes model changes", () => {
  const sol = policyFor({ model: "gpt-5.6-sol", runtime: "codex" });
  const opus = policyFor({ model: "claude-opus-5", runtime: "claude" });
  expect(sol).toMatchObject({
    mode: "high",
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
    runtime: "codex",
  });
  expect(sol.policyHash).not.toBe(opus.policyHash);
  expect(sol.definitionHash).toBe(opus.definitionHash);
});
```

Add adapter assertions proving both adapters use `execution.policy.model` and
`execution.policy.reasoningEffort` and refuse a profile whose runtime does not match the adapter.

**Step 2: Run focused tests and verify RED**

Run: `npx vitest run test/agents/modes.test.ts test/execution/execution-service.test.ts test/runtime/runtime-adapters.test.ts`

Expected: FAIL because policy does not contain the resolved profile.

**Step 3: Extend the immutable policy contract**

Add required fields to `ExecutionPolicy`:

```ts
readonly mode: ModeId;
readonly model: string;
readonly reasoningEffort: ReasoningEffort;
readonly runtime: RuntimeId;
```

Replace `PrepareExecutionInput.mode` with required `launchProfile: ResolvedLaunchProfile`.
Validate that `launchProfile.agent === input.target` and
`runtimeForModel(launchProfile.model) === launchProfile.runtime` before authorization side effects.
Include the four launch fields in the canonical policy snapshot and hash.

**Step 4: Make adapters consume the policy snapshot**

Reduce runtime prepare input to:

```ts
export interface RuntimePrepareInput {
  readonly execution: PreparedExecution;
  readonly interactive: boolean;
}
```

Claude and Codex adapters read model/effort from `input.execution.policy`. Each adapter throws if
`policy.runtime !== this.name`. Update the shared execution fixture so all downstream tests receive
a complete policy.

**Step 5: Run focused tests and typecheck**

Run: `npx vitest run test/agents/modes.test.ts test/execution test/runtime/runtime-adapters.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/execution src/runtime test/support/execution-fixture.ts test/agents/modes.test.ts test/execution test/runtime/runtime-adapters.test.ts
git commit -m "feat(execution): bind resolved model routing to policy"
```

### Task 5: Route main, delegation, and mode commands through settings

**Files:**
- Modify: `src/cli/mode-selector.ts`
- Delete: `src/cli/mode-preference-store.ts`
- Modify: `src/cli/commands/mode.ts`
- Modify: `src/cli/commands/run-main.ts`
- Modify: `src/cli/commands/delegate.ts`
- Modify: `src/cli/alp.ts`
- Modify: `src/delegation/delegation-service.ts`
- Modify: `test/cli/mode-selector.test.ts`
- Modify: `test/e2e/mode-selection.test.ts`
- Modify: `test/cli/alp.test.ts`
- Modify: `test/delegation/delegation-service.test.ts`
- Modify: `test/e2e/alp-main.test.ts`
- Modify: `test/e2e/alp-delegation.test.ts`

**Step 1: Write failing mode precedence tests**

Update selector tests so `configuredMode` is passed in and persistence delegates to
`writeGlobalMode`. Lock precedence with table-driven cases:

```ts
it.each([
  ["flag", "ultra", "medium", "ultra"],
  ["env", "puck", "medium", "puck"],
  ["config", undefined, "high", "high"],
])("selects %s mode before launch", async (_source, requestedMode, configuredMode, expected) => {
  const result = await selector.select({ requestedMode, configuredMode, interactive: false });
  expect(result).toMatchObject({ ok: true, mode: expected });
});
```

Add main and delegation tests with a settings fixture that changes `high.main` and `high.search`.
Assert the prepared policy and adapter runtime both use those configured values.

**Step 2: Run focused tests and verify RED**

Run: `npx vitest run test/cli/mode-selector.test.ts test/cli/alp.test.ts test/delegation/delegation-service.test.ts`

Expected: FAIL because production composition still uses `MODE_PROFILES` directly.

**Step 3: Refactor selector and mode command**

Make `ModeSelector.select()` accept the configured mode and use an injected
`writeGlobalMode(mode)` callback only after interactive confirmation. Remove all reads/writes of
`mode.json`.

`runModeCommand(show)` loads the effective settings for the current `cwd`; `set` updates only the
global mode and prints the selected value. A project-local override may therefore remain the
effective mode after a global `set`, which is intentional and documented.

**Step 4: Resolve once in main and delegation**

Inject `FileSettingsStore` into the default CLI composition. For each invocation:

1. Load effective settings once.
2. Apply `--mode`/`ALP_MODE` precedence.
3. Resolve the target agent launch profile from that snapshot.
4. Pass the profile to `ExecutionService.prepare`.
5. Select `adapters.get(execution.policy.runtime)`.
6. Call `adapter.prepare({ execution, interactive })` without model/effort arguments.

Change `DelegationServiceConfig` to hold the effective settings snapshot plus optional requested
mode. Do not reload settings inside `prepare()`.

**Step 5: Run focused and end-to-end tests**

Run: `npx vitest run test/cli test/delegation test/e2e/mode-selection.test.ts test/e2e/alp-main.test.ts test/e2e/alp-delegation.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/cli src/delegation test/cli test/delegation test/e2e/mode-selection.test.ts test/e2e/alp-main.test.ts test/e2e/alp-delegation.test.ts
git commit -m "feat(cli): route sessions through layered settings"
```

### Task 6: Create project-local settings during `alp init`

**Files:**
- Modify: `src/cli/commands/init.ts`
- Modify: `test/cli/alp-init.test.ts`

**Step 1: Write failing init tests**

```ts
it("creates an excluded project-local settings template without replacing user content", async () => {
  await initializeProject({ project, repoRoot }, { store });
  const local = join(project, ".alp", "setting.local.json");
  expect(JSON.parse(await readFile(local, "utf8"))).toEqual({ $schema: SETTINGS_SCHEMA_URL });
  await expectPosixMode(local, 0o600);
  expect(await readFile(join(project, ".git", "info", "exclude"), "utf8"))
    .toContain(".alp/setting.local.json");

  await writeFile(local, JSON.stringify({ mode: "ultra" }));
  await initializeProject({ project, repoRoot }, { store });
  expect(JSON.parse(await readFile(local, "utf8"))).toEqual({ mode: "ultra" });
});
```

Also assert `alp deinit` does not delete the user-owned local settings file.

**Step 2: Run the focused test and verify RED**

Run: `npx vitest run test/cli/alp-init.test.ts`

Expected: FAIL because init does not create local settings.

**Step 3: Implement non-destructive local creation**

Generalize local excludes to include both `.claude/settings.local.json` and
`.alp/setting.local.json`. Create the ALP local file only when absent, using the shared schema URL,
atomic write, and `0600`. Never back up, replace, or remove it because it becomes user-owned as
soon as created.

Export a `refreshGeneratedProjectHooks(project, repoRoot)` helper that rewrites only existing
Claude settings carrying `$generatedBy: "alp init"`; this will be used by legacy install migration.

**Step 4: Run tests**

Run: `npx vitest run test/cli/alp-init.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/cli/commands/init.ts test/cli/alp-init.test.ts
git commit -m "feat(init): scaffold project-local ALP settings"
```

### Task 7: Generate global settings and migrate `mode.json` in bootstrap

**Files:**
- Modify: `src/settings/settings-store.ts`
- Modify: `scripts/bootstrap.cjs`
- Modify: `scripts/lib/update.cjs`
- Modify: `scripts/test-update.cjs`
- Create: `scripts/test-settings-bootstrap.cjs`
- Modify: `package.json`

**Step 1: Write failing migration tests**

Create a script fixture that calls the compiled/store bootstrap helper against a temporary home:

```js
fs.writeFileSync(path.join(alpRoot, "mode.json"), '{"mode":"ultra"}\n');
await ensureGlobalSettings({ home });
const setting = JSON.parse(fs.readFileSync(path.join(alpRoot, "setting.json"), "utf8"));
assert.strictEqual(setting.mode, "ultra");
assert(setting.modes.high["agent-teams"].main.model);
assert(!fs.existsSync(path.join(alpRoot, "mode.json")));
```

Add cases for preserving customized leaves, filling newly missing fields, and retaining an invalid
legacy `mode.json` with a warning.

**Step 2: Run the script and verify RED**

Run: `npm run build && node scripts/test-settings-bootstrap.cjs`

Expected: FAIL because bootstrap settings migration does not exist.

**Step 3: Implement bootstrap settings ensure/migration**

Extend `ensureGlobalSettings()` to read a legacy mode only when the new document has no mode. Write
the complete merged document atomically first, then remove the valid legacy file. Return structured
`created`, `added`, `migratedMode`, and `warnings` data for bootstrap logging.

Convert `scripts/bootstrap.cjs` to an async `main()` with a terminal `.catch(die)`. After `npm run
build`, require the compiled settings store, call `ensureGlobalSettings`, and refresh generated
project hooks using `~/.alp/projects.json`. Do not create or touch project-local settings for
projects that were not explicitly initialized.

**Step 4: Preserve the new file during maintenance**

Replace `mode.json` in `preserveMaintenanceState()` with `setting.json`; keep legacy `mode.json` in
the temporary preservation list for one migration release. Extend `scripts/test-update.cjs` to
assert customized settings survive a failed or successful bootstrap.

**Step 5: Run script tests**

Run: `npm run build && node scripts/test-settings-bootstrap.cjs && node scripts/test-update.cjs`

Expected: both scripts print `OK` and exit 0.

**Step 6: Commit**

```bash
git add src/settings/settings-store.ts scripts/bootstrap.cjs scripts/lib/update.cjs scripts/test-update.cjs scripts/test-settings-bootstrap.cjs package.json
git commit -m "feat(bootstrap): create settings and migrate mode preference"
```

### Task 8: Move the default installation to `~/.alp/app`

**Files:**
- Modify: `install.sh`
- Modify: `install.ps1`
- Create: `scripts/test-installer-layout.cjs`
- Modify: `scripts/test-windows-installer.cjs`
- Modify: `package.json`

**Step 1: Write failing installer layout fixtures**

For Bash, execute a copy of `install.sh` with temporary `HOME` and fake `git`/`node` commands.
Assert:

- Fresh default target is `$HOME/.alp/app`.
- A valid `$HOME/.alp-code` moves to `$HOME/.alp/app` when the new target is absent.
- Existing `$HOME/.alp` state survives the move.
- When old and new checkouts coexist, new wins and old remains untouched with a warning.
- Explicit `ALP_HOME` bypasses default-path migration.

Extend the Windows harness with equivalent path assertions using `USERPROFILE` and filesystem
fixtures.

**Step 2: Run fixtures and verify RED**

Run: `node scripts/test-installer-layout.cjs`

Expected: FAIL because the Unix default remains `~/.alp-code`.

On Windows also run: `node scripts/test-windows-installer.cjs`

Expected: FAIL on the new default/migration assertions.

**Step 3: Implement safe Bash migration**

Track whether `--home` or `ALP_HOME` was supplied. Otherwise set:

```bash
ALP_ROOT="$HOME/.alp"
TARGET="$ALP_ROOT/app"
LEGACY_TARGET="$HOME/.alp-code"
```

Before normal checkout handling, create `ALP_ROOT`. Move the legacy directory only if the target is
absent and the legacy path contains `.git`, `package.json`, and `scripts/bootstrap.cjs`. If both
exist, warn and continue with the new target. If the legacy path is unrecognized, stop with an
actionable error instead of moving it.

**Step 4: Implement equivalent PowerShell behavior**

Use `Join-Path $HOME '.alp\app'`, `Move-Item -LiteralPath`, and the same validity checks. Preserve
PowerShell 5.1 compatibility and the existing child-scope behavior.

**Step 5: Run installer tests**

Run: `node scripts/test-installer-layout.cjs`

Expected: PASS.

On Windows run: `node scripts/test-windows-installer.cjs`

Expected: PASS under every available PowerShell engine.

**Step 6: Commit**

```bash
git add install.sh install.ps1 scripts/test-installer-layout.cjs scripts/test-windows-installer.cjs package.json
git commit -m "feat(install): consolidate default layout under dot alp"
```

### Task 9: Make uninstall safe for the nested app layout

**Files:**
- Modify: `scripts/lib/uninstall.cjs`
- Modify: `scripts/test-uninstall.cjs`
- Modify: `src/cli/commands/init.ts`
- Modify: `test/cli/alp-init.test.ts`

**Step 1: Write failing nested-layout tests**

Build a fixture with `repoRoot = <home>/.alp/app`, global settings beside it, and memory inside the
app. Assert normal uninstall:

- Removes only the validated app checkout before state cleanup.
- Places the memory backup at `<home>/.alp-memory-backup-<timestamp>` so cleanup cannot delete it.
- Cleans generated project runtime hooks without deleting `.alp/setting.local.json`.
- Never passes `HOME`, `~`, `/`, or the unresolved `.alp` parent to recursive deletion without an
  exact target validation.

**Step 2: Run the uninstall fixture and verify RED**

Run: `node scripts/test-uninstall.cjs`

Expected: FAIL because the current memory backup is created inside `~/.alp` and is then removed by
runtime-state cleanup.

**Step 3: Implement explicit cleanup targets**

When the repo is exactly `<home>/.alp/app`, calculate memory backup beside `.alp`, not inside it.
Validate the code root with `assertInstallRoot()` before deletion and validate the runtime root as
exactly `<home>/.alp` before cleanup. Keep custom `ALP_HOME` support: removing a custom checkout must
not recursively remove its parent.

Preserve project-local ALP settings on deinit/uninstall. Continue removing only Claude/Codex files
that carry ALP's generated marker.

**Step 4: Run tests**

Run: `node scripts/test-uninstall.cjs && npx vitest run test/cli/alp-init.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/lib/uninstall.cjs scripts/test-uninstall.cjs src/cli/commands/init.ts test/cli/alp-init.test.ts
git commit -m "fix(uninstall): preserve data outside nested app cleanup"
```

### Task 10: Update documentation and run the full verification gate

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/model-routing.md`
- Modify: `docs/delegation.md`
- Modify: `CHANGELOG.md`
- Modify: `scripts/doctor.cjs`
- Modify: `scripts/test-cli-link.cjs`
- Modify: any tests still referring to `~/.alp/mode.json` or `~/.alp-code`

**Step 1: Write failing documentation/doctor assertions**

Update script assertions so help, doctor remediation, updater preservation, and CLI-link fixtures
expect `~/.alp/setting.json` and the default checkout `~/.alp/app`. Add a doctor check that parses
the effective settings for the current workspace and reports the exact invalid source path.

**Step 2: Run targeted checks and verify RED**

Run: `rg -n '\.alp-code|\.alp/mode\.json|mode\.json' README.md docs src scripts test install.sh install.ps1`

Expected before cleanup: matches outside intentional migration compatibility and changelog history.

Run: `node scripts/test-cli-link.cjs`

Expected: FAIL where old layout assertions remain.

**Step 3: Update docs and health output**

Document:

- The global and local paths.
- The `agent-teams` schema with a partial override example.
- Deep-merge and mode precedence.
- Strict model catalog/runtime behavior.
- The new install tree and legacy migration.
- Policy snapshot fields and hash behavior.

Keep old paths only in historical changelog entries or explicit migration notes.

**Step 4: Run complete automated verification**

Run: `npm run typecheck`

Expected: PASS.

Run: `npm test`

Expected: all Vitest suites PASS.

Run:

```bash
node scripts/test-settings-bootstrap.cjs
node scripts/test-installer-layout.cjs
node scripts/test-update.cjs
node scripts/test-uninstall.cjs
node scripts/test-cli-link.cjs
node scripts/test-delegation.cjs
node scripts/test-execution-hooks.cjs
node scripts/test-checkout-release.cjs
```

Expected: every script exits 0 and prints its `OK` summary. Run
`node scripts/test-windows-installer.cjs` on Windows; on other systems its explicit `SKIP` is
acceptable.

Run: `git diff --check`

Expected: no output.

Run: `git status --short`

Expected: only intended implementation/doc changes before the final commit.

**Step 5: Request code review**

Invoke `@superpowers:requesting-code-review`. Address only verified findings, rerun the focused test
for each change, then repeat Step 4.

**Step 6: Commit**

```bash
git add README.md docs CHANGELOG.md scripts/doctor.cjs scripts/test-cli-link.cjs src test install.sh install.ps1 package.json
git commit -m "docs(settings): document layered config and app layout"
```

**Step 7: Final verification**

Invoke `@superpowers:verification-before-completion`, rerun `npm run typecheck`, `npm test`, the
script suite above, `git diff --check`, and `git status --short`. Record exact pass counts and any
platform-only skip in the handoff.
