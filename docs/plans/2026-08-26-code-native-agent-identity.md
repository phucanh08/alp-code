# Code-native Agent Identity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Markdown/YAML runtime identity with TypeScript agent definitions, code-enforced policy/workflows, selectable Claude/Codex runtimes, and a Markdown-backed `MemoryStore` interface ready for a future server API.

**Architecture:** ALP becomes the only supported launcher. It resolves an immutable `AgentDefinition`, authorizes the request, obtains scoped context through `MemoryService`, creates an identity capsule plus execution-policy snapshot, asks a Claude/Codex adapter for a launch specification, and delegates lifecycle to a local/Herdr/Paseo execution backend. Memory data remains Markdown behind a storage-neutral port.

**Tech Stack:** Node.js, TypeScript, CommonJS-compatible build output, Zod, Vitest, existing Node/CJS runtime adapters and CLI installers.

**Safety:** Do not commit or push unless the principal explicitly requests it. Preserve unrelated existing deletions in the worktree. Do not delete legacy identity files until the cutover task and full verification are complete.

---

### Task 1: Add TypeScript build and test infrastructure

**Files:**
- Create: `package.json`
- Create: `package-lock.json` via `npm install`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/index.ts`
- Create: `test/smoke.test.ts`
- Modify: `.gitignore`

**Step 1: Write the failing smoke test**

```ts
import { describe, expect, it } from "vitest";
import { ALP_CORE_VERSION } from "../src/index";

describe("ALP TypeScript core", () => {
  it("loads through the test runner", () => {
    expect(ALP_CORE_VERSION).toBe(1);
  });
});
```

**Step 2: Add the minimal package definition**

```json
{
  "name": "alp-code",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

Configure `tsconfig.json` with `target: ES2022`, `module: CommonJS`, `moduleResolution: Node`, `rootDir: .`, `outDir: dist`, `strict: true`, and include `src/**/*.ts`, `test/**/*.ts`, and `vitest.config.ts`.

**Step 3: Run the test and verify it fails**

Run: `npm install && npm test -- test/smoke.test.ts`  
Expected: FAIL because `src/index.ts` does not export `ALP_CORE_VERSION`.

**Step 4: Add the minimal implementation**

```ts
export const ALP_CORE_VERSION = 1 as const;
```

**Step 5: Verify test and build**

Run: `npm test -- test/smoke.test.ts && npm run typecheck && npm run build`  
Expected: one passing test, typecheck exit 0, compiled output under `dist/`.

**Step 6: Ignore build output only**

Add `dist/` to `.gitignore`; do not ignore `package-lock.json`.

---

### Task 2: Define agent-domain types and immutable registry

**Files:**
- Create: `src/agents/types.ts`
- Create: `src/agents/agent-definition.ts`
- Create: `src/agents/registry.ts`
- Create: `src/agents/errors.ts`
- Test: `test/agents/registry.test.ts`

**Step 1: Write failing registry invariant tests**

Cover:

- unique role IDs;
- `reportsTo` points to a known role or `principal`;
- every `delegatesTo` target exists;
- no self-delegation;
- workspace write roots are a subset of read roots;
- memory write grants are a subset of read grants;
- a role cannot grant another role's private scope;
- returned definitions are frozen.

Example:

```ts
expect(() => createAgentRegistry([
  defineAgent({ ...probe, id: "probe" }),
  defineAgent({ ...probe, id: "probe" }),
])).toThrowError(/duplicate agent `probe`/);
```

**Step 2: Run the test and verify it fails**

Run: `npm test -- test/agents/registry.test.ts`  
Expected: FAIL because registry modules do not exist.

**Step 3: Implement the minimal domain types**

Define branded/string unions for `AgentId`, `ToolId`, `RuntimeId`, memory grants, workspace grants, model maps, workflow references, and output contracts. Keep filesystem and runtime-process types out of this module.

**Step 4: Implement `defineAgent` and `AgentRegistry`**

```ts
export interface AgentRegistry {
  get(id: AgentId): AgentDefinition<unknown>;
  has(id: AgentId): boolean;
  list(): readonly AgentDefinition<unknown>[];
}
```

Freeze definitions and registry arrays after validation. Include a synthetic `principal` only in delegation policy, not in the persistent registry.

**Step 5: Run focused and full new tests**

Run: `npm test -- test/agents/registry.test.ts && npm run typecheck`  
Expected: PASS.

---

### Task 3: Port CHARTER invariants into `PolicyEngine`

**Files:**
- Create: `src/policy/types.ts`
- Create: `src/policy/errors.ts`
- Create: `src/policy/invariants.ts`
- Create: `src/policy/delegation-policy.ts`
- Create: `src/policy/memory-policy.ts`
- Create: `src/policy/workspace-policy.ts`
- Create: `src/policy/policy-engine.ts`
- Test: `test/policy/policy-engine.test.ts`
- Reference: `scripts/lib/loadout.cjs`
- Reference: `hooks/acl-guard.cjs`
- Reference: `scripts/lib/delegation/core/policy.cjs`

**Step 1: Write the deny-first policy matrix**

Create table-driven tests for:

- main cannot read another role's private memory;
- a specialist cannot delegate;
- main can delegate only to exact declared targets;
- target `reportsTo` must equal parent;
- raw Herdr/Paseo/spawn tools are always denied;
- read-only workspace rejects writes;
- delegated execution rejects registered workspaces other than its active workspace;
- role cannot mutate policy source or its own definition;
- unknown/indirect tool request fails closed.

**Step 2: Run and verify failure**

Run: `npm test -- test/policy/policy-engine.test.ts`  
Expected: FAIL because `PolicyEngine` is missing.

**Step 3: Implement typed authorization results**

```ts
type Authorization =
  | { allowed: true }
  | { allowed: false; code: PolicyErrorCode; reason: string };
```

Do not throw for ordinary denial; reserve exceptions for invalid policy state.

**Step 4: Implement delegation, memory, workspace, and tool checks**

Resolve and canonicalize filesystem paths once at the boundary. Preserve the existing guardrail limitation explicitly; do not claim hostile-process isolation.

**Step 5: Verify parity with legacy isolation tests**

Run:

```bash
npm test -- test/policy/policy-engine.test.ts
node scripts/test-isolation.cjs
```

Expected: new policy tests pass and legacy isolation remains `39/39`.

---

### Task 4: Define the memory port and service boundary

**Files:**
- Create: `src/memory/types.ts`
- Create: `src/memory/errors.ts`
- Create: `src/memory/memory-store.ts`
- Create: `src/memory/memory-service.ts`
- Create: `src/memory/context-ranker.ts`
- Test: `test/memory/memory-service.test.ts`

**Step 1: Write failing service tests with an in-memory fake**

Test:

- private entry visible only to its owner;
- shared/project reads obey grants;
- unauthorized write never calls the store;
- version conflict is preserved as a typed error;
- context building honors a character budget;
- policy/invariant context is never mixed into trimmable memory context;
- audit metadata records actor, operation, logical ID, and result.

**Step 2: Run and verify failure**

Run: `npm test -- test/memory/memory-service.test.ts`  
Expected: FAIL because memory contracts are missing.

**Step 3: Implement the storage-neutral interface**

Use logical IDs and an opaque numeric version. Do not expose filesystem paths or HTTP URLs through the domain interface.

**Step 4: Implement `MemoryService`**

Constructor dependencies:

```ts
new MemoryService({ store, policy, audit, ranker });
```

Authorize before every store call. `buildContext` should return entries plus truncation diagnostics, not a single untraceable string.

**Step 5: Verify**

Run: `npm test -- test/memory/memory-service.test.ts && npm run typecheck`  
Expected: PASS.

---

### Task 5: Implement `MarkdownFileStore` and API-ready contract tests

**Files:**
- Create: `src/memory/adapters/markdown-file-store.ts`
- Create: `src/memory/adapters/memory-path-mapper.ts`
- Create: `src/memory/adapters/memory-api-client.ts`
- Create: `src/memory/adapters/remote-api-store.ts`
- Test: `test/memory/memory-store.contract.ts`
- Test: `test/memory/markdown-file-store.test.ts`
- Test: `test/memory/remote-api-store.test.ts`

**Step 1: Write a reusable `MemoryStore` contract suite**

The suite must cover create/get/search/update/delete, stable logical IDs, atomic replacement, expected-version conflicts, and missing-entry behavior.

**Step 2: Run against an unimplemented file store**

Run: `npm test -- test/memory/markdown-file-store.test.ts`  
Expected: FAIL.

**Step 3: Implement deterministic path mapping**

Map scopes without accepting caller-supplied paths:

```text
shared:<id>             → memory/shared/<id>.md
project:<slug>:<id>     → memory/projects/<slug>/<id>.md
private:<role>:<id>     → memory/private/<role>/<id>.md
```

Reject `..`, absolute paths, empty segments, and symlink escapes. Preserve existing Markdown body content. Use a temporary sibling file plus rename for writes.

**Step 4: Implement versioning and search**

Use a monotonic sidecar metadata index under the memory root so a same-millisecond write cannot bypass optimistic concurrency. Rebuild the sidecar from files if absent; never overwrite memory merely to rebuild metadata.

Start search with deterministic filename/frontmatter/content matching. Do not add embeddings in this migration.

**Step 5: Implement the future API adapter against an injected client**

`RemoteApiStore` delegates to `MemoryApiClient`; do not invent endpoint URLs or authentication. Tests use a fake client and the same contract suite.

**Step 6: Verify both adapters**

Run:

```bash
npm test -- test/memory/markdown-file-store.test.ts test/memory/remote-api-store.test.ts
```

Expected: both satisfy the common contract.

---

### Task 6: Port all roles to code-native definitions

**Files:**
- Create: `src/agents/shared/principal.ts`
- Create: `src/agents/shared/voice.ts`
- Create: `src/agents/shared/house-rules.ts`
- Create: `src/agents/main.ts`
- Create: `src/agents/search.ts`
- Create: `src/agents/librarian.ts`
- Create: `src/agents/read-thread.ts`
- Create: `src/agents/review.ts`
- Create: `src/agents/oracle.ts`
- Create: `src/agents/compaction.ts`
- Create: `src/agents/titling.ts`
- Modify: `src/agents/registry.ts`
- Test: `test/agents/definitions.test.ts`
- Reference: `identity/*/loadout.yaml`
- Reference: `identity/*/{IDENTITY,SOUL,PLAYBOOK,RELATIONS}.md`

**Step 1: Write expected-definition tests from the approved role matrix**

Lock role IDs, models, reasoning effort, reports/delegates topology, memory grants, tool grants, and output-contract names.

**Step 2: Port `titling` first**

Implement one-line output schema and a single deterministic workflow. Verify that it has no shared/project memory grant and no delegation capability.

**Step 3: Port retrieval and review roles**

Port `search`, `read-thread`, `review`, `librarian`, `oracle`, and `compaction`. Put reusable language fragments in typed shared functions, not copied string blocks.

**Step 4: Port `main` last**

Main owns coordination and exact specialist allowlist but still cannot read specialist private memory. Map Claude and Codex models separately.

**Step 5: Verify definitions and registry**

Run: `npm test -- test/agents/definitions.test.ts test/agents/registry.test.ts`  
Expected: eight role definitions pass all registry invariants.

---

### Task 7: Implement workflows and structured output validation

**Files:**
- Create: `src/workflow/types.ts`
- Create: `src/workflow/workflow-runner.ts`
- Create: `src/workflow/output-validator.ts`
- Create: `src/workflow/repair-policy.ts`
- Test: `test/workflow/workflow-runner.test.ts`
- Modify: `src/agents/*.ts`

**Step 1: Write failing transition tests**

Test legal/illegal transitions, terminal states, allowed tools per state, one repair maximum, validation failure after repair, and cancellation.

**Step 2: Implement the minimal deterministic state machine**

```ts
interface WorkflowDefinition {
  initial: WorkflowStateId;
  states: Readonly<Record<WorkflowStateId, WorkflowStateDefinition>>;
}
```

Reject undeclared transitions. Workflow state must be serializable in execution state.

**Step 3: Add Zod output contracts per role**

Keep schemas structural. Do not attempt to validate subjective answer quality in code; validate required evidence, fields, enum values, and output shape.

**Step 4: Verify**

Run: `npm test -- test/workflow/workflow-runner.test.ts test/agents/definitions.test.ts`  
Expected: PASS.

---

### Task 8: Build identity capsules and immutable execution snapshots

**Files:**
- Create: `src/execution/types.ts`
- Create: `src/execution/identity-capsule.ts`
- Create: `src/execution/execution-policy.ts`
- Create: `src/execution/execution-store.ts`
- Create: `src/execution/execution-service.ts`
- Test: `test/execution/identity-capsule.test.ts`
- Test: `test/execution/execution-service.test.ts`

**Step 1: Write failing capsule tests**

Verify that a capsule contains role instructions, task, active workspace, allowed memory context, workflow state, allowed tools, execution ID, and definition hash—but never another role's private memory or raw `MemoryStore` paths.

**Step 2: Write snapshot immutability tests**

Create an execution, mutate/replace the registry definition in the test fixture, and verify the running execution retains its original policy hash and grants.

**Step 3: Implement atomic state storage**

Use `~/.alp/executions/<id>/state.json`, `policy.json`, and temporary runtime config. Write via temp file and rename. Use restrictive directory/file modes where supported.

**Step 4: Implement `ExecutionService.prepare`**

Order is mandatory:

```text
resolve roles → authorize → resolve workspace → build memory context
→ initialize workflow → snapshot policy → create capsule
```

No backend probe or spawn may happen before authorization succeeds.

**Step 5: Verify**

Run: `npm test -- test/execution`  
Expected: PASS.

---

### Task 9: Add remembered Claude/Codex runtime selection

**Files:**
- Create: `src/runtime/types.ts`
- Create: `src/runtime/runtime-preference-store.ts`
- Create: `src/runtime/runtime-selector.ts`
- Test: `test/runtime/runtime-selector.test.ts`

**Step 1: Write precedence and persistence tests**

Test:

- `--runtime` wins and skips prompt;
- interactive selection wins over stored preference;
- Enter accepts highlighted stored preference;
- no state defaults to Claude;
- invalid/corrupt preference fails closed to the documented default with a warning;
- selection persists atomically;
- cancellation returns exit 130;
- stdin is paused and raw mode restored.

**Step 2: Run and verify failure**

Run: `npm test -- test/runtime/runtime-selector.test.ts`  
Expected: FAIL.

**Step 3: Implement the selector using injected terminal I/O**

Reuse the cross-platform key handling patterns from `scripts/lib/delegation/init-backend.cjs`, but keep runtime preference separate from backend preference.

**Step 4: Verify**

Run: `npm test -- test/runtime/runtime-selector.test.ts`  
Expected: PASS on non-TTY fixtures and simulated Windows-style key chunks.

---

### Task 10: Separate runtime translation from execution backends

**Files:**
- Create: `src/runtime/runtime-adapter.ts`
- Create: `src/runtime/claude-adapter.ts`
- Create: `src/runtime/codex-adapter.ts`
- Create: `src/backend/execution-backend.ts`
- Create: `src/backend/local-process-backend.ts`
- Port/Modify: `scripts/lib/delegation/backends/herdr/backend.cjs`
- Port/Modify: `scripts/lib/delegation/backends/paseo/backend.cjs`
- Test: `test/runtime/runtime-adapters.test.ts`
- Test: `test/backend/local-process-backend.test.ts`
- Test: `test/backend/delegated-backends.test.ts`

**Step 1: Write runtime launch-spec tests**

Given the same capsule, assert Claude/Codex adapters produce their correct binary, arguments, environment, prompt/config location, sandbox mode, and execution ID. Ensure project repositories are untouched.

**Step 2: Implement `RuntimeAdapter.prepare`**

```ts
interface RuntimeLaunchSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  temporaryFiles: readonly string[];
}
```

**Step 3: Write backend contract tests**

Backends receive a launch spec and own `spawn/status/wait/cancel/cleanup`. They must not import the agent registry, memory service, or policy definitions.

**Step 4: Implement local process backend**

Use it for interactive `alp`. Preserve exit code and signals; cleanup temporary runtime config after the process exits while retaining execution result/state.

**Step 5: Adapt Herdr and Paseo**

Remove their direct dependency on loadout/profile builders. They execute the prepared launch spec and preserve existing generic lifecycle mapping.

**Step 6: Verify**

Run:

```bash
npm test -- test/runtime test/backend
node scripts/test-delegation-backends.cjs
```

Expected: new tests pass; legacy backend behavior remains green during the compatibility phase.

---

### Task 11: Rewire DelegationService to code-native agents

**Files:**
- Create: `src/delegation/delegation-service.ts`
- Create: `src/delegation/backend-registry.ts`
- Create: `src/delegation/types.ts`
- Modify: `scripts/delegate.cjs`
- Modify: `scripts/run-role.cjs`
- Test: `test/delegation/delegation-service.test.ts`
- Reference: `scripts/lib/delegation/core/service.cjs`

**Step 1: Port current neutral lifecycle tests to TypeScript**

Preserve request/execution IDs, statuses, backend pinning, fallback-before-spawn only, result routing, and typed errors.

**Step 2: Replace loadout registry/context builder dependencies**

Inject `AgentRegistry`, `PolicyEngine`, `MemoryService`, `ExecutionService`, runtime adapters, and backend registry.

**Step 3: Prove deny happens before backend activity**

Use a fake backend with counters and assert unauthorized delegation performs zero health/spawn calls.

**Step 4: Keep CJS compatibility wrappers temporarily**

Wrappers load compiled `dist` modules and forward argv. Do not duplicate policy in wrappers.

**Step 5: Verify**

Run:

```bash
npm test -- test/delegation/delegation-service.test.ts
node scripts/test-delegation-core.cjs
node scripts/test-delegation.cjs
```

Expected: new and compatibility tests pass.

---

### Task 12: Switch `alp` main-session UX and simplify `alp init`

**Files:**
- Create: `src/cli/alp.ts`
- Create: `src/cli/commands/run-main.ts`
- Create: `src/cli/commands/runtime.ts`
- Create: `src/cli/commands/init.ts`
- Create: `src/cli/commands/delegate.ts`
- Modify: `scripts/alp.cjs`
- Modify: `scripts/lib/cli-link.cjs`
- Modify: `scripts/lib/project-config.cjs`
- Test: `test/cli/alp.test.ts`
- Test: `test/cli/alp-init.test.ts`

**Step 1: Write CLI parsing tests**

Cover:

```text
alp
alp --runtime claude
alp --runtime codex
alp runtime show
alp runtime set codex
alp init [path] [--backend x]
alp delegate <role> ...
```

Reject multiple runtimes, unknown commands, and identity-aware raw-runtime shortcuts.

**Step 2: Implement `alp` main launch**

Resolve `main`, select runtime, prepare execution, create runtime launch spec, and use the local-process backend. CWD remains the active project.

**Step 3: Simplify `alp init`**

Keep backend selection, project registration, and workspace state. Stop creating:

```text
<project>/.claude/settings.local.json
<project>/.codex/config.toml
<project>/.claude/skills/*
<project>/.agents/skills/*
```

Stop modifying Claude/Codex trust for direct project launch. Update `alp deinit` to remove legacy generated artifacts if present while remaining idempotent.

**Step 4: Update CLI installation target**

Point the global shim at compiled `dist/src/cli/alp.js` or a minimal stable CJS bootstrap that ensures/builds `dist` and loads it.

**Step 5: Verify project cleanliness**

Create a temporary Git repository, run new `alp init`, and assert `git status --porcelain` is unchanged and no runtime config directories are created.

**Step 6: Run tests**

Run: `npm test -- test/cli`  
Expected: PASS.

---

### Task 13: Update bootstrap, installer, doctor, update, and uninstall

**Files:**
- Modify: `scripts/bootstrap.cjs`
- Modify: `scripts/doctor.cjs`
- Modify: `scripts/lib/update.cjs`
- Modify: `scripts/lib/uninstall.cjs`
- Modify: `install.sh`
- Modify: `install.ps1`
- Modify: `README.md`
- Test: `scripts/test-cli-link.cjs`
- Test: `scripts/test-update.cjs`
- Test: `scripts/test-uninstall.cjs`
- Test: `scripts/test-windows-installer.cjs`

**Step 1: Add failing installer/bootstrap tests**

Assert a clean install runs `npm ci`, builds TypeScript, initializes memory/delegation state, installs the CLI, and no longer compiles/trusts identity workspaces.

**Step 2: Replace compile/trust bootstrap steps**

Bootstrap should validate `AgentRegistry`, verify runtime adapters, ensure memory root and execution state, build if needed, and run doctor.

**Step 3: Replace doctor checks**

Remove Registry/loadout/ACL-profile/skill-link drift checks. Add:

- `AGENT-REGISTRY` validation;
- `RUNTIME-CLAUDE` and `RUNTIME-CODEX` probes;
- memory adapter health;
- execution state permissions/orphans;
- stale legacy identity/config detection;
- build artifact/source hash drift.

**Step 4: Update update/uninstall semantics**

`alp update` must preserve user runtime/backend preferences and memory while rebuilding code. `alp uninstall` must remove compiled CLI/runtime state according to existing backup/purge rules, without deleting memory unless explicitly requested.

**Step 5: Verify cross-platform maintenance paths**

Run:

```bash
node scripts/test-cli-link.cjs
node scripts/test-update.cjs
node scripts/test-uninstall.cjs
node scripts/test-windows-installer.cjs
```

Expected: all exit 0.

---

### Task 14: Cut over and remove legacy identity infrastructure

**Files:**
- Delete: `CHARTER.md`
- Delete: `identity/`
- Delete: repository/nested runtime `AGENTS.md`
- Delete: repository/nested runtime `CLAUDE.md`
- Delete: `scripts/compile-acl.cjs`
- Delete: `scripts/compile-acl.sh`
- Delete: `scripts/compile-acl.ps1`
- Delete: `scripts/trust-role.cjs`
- Delete: `scripts/trust-role.sh`
- Delete: `scripts/trust-role.ps1`
- Delete: `scripts/lib/loadout.cjs`
- Delete: `scripts/lib/claude-settings.cjs`
- Delete: `scripts/lib/codex-profile.cjs`
- Delete: `scripts/lib/skill-links.cjs`
- Delete or replace: `hooks/session-start.cjs`
- Replace: `hooks/acl-guard.cjs`
- Replace: `hooks/session-end.cjs`
- Modify: tests and docs that reference removed files
- Test: `test/cutover/no-legacy-identity.test.ts`

**Step 1: Write the no-legacy-source test before deletion**

The test should fail while any runtime path imports or reads `CHARTER.md`, `identity/`, `loadout.yaml`, `AGENTS.md`, or `CLAUDE.md`.

**Step 2: Run and verify failure**

Run: `npm test -- test/cutover/no-legacy-identity.test.ts`  
Expected: FAIL with a list of remaining imports/read paths.

**Step 3: Remove legacy runtime dependencies first**

Use `rg` to eliminate code references. Human documentation may describe historical migration but must not be read by runtime code.

**Step 4: Delete legacy sources and generated artifacts**

Delete only after all execution paths use the TypeScript registry. Preserve `memory/**/*.md` and project documentation.

**Step 5: Replace hooks with execution-policy bridges**

The new PreToolUse bridge accepts an execution ID and delegates to compiled `PolicyEngine`. Stop/finalization delegates to `WorkflowRunner`; no hook reads identity Markdown.

**Step 6: Run the cutover test**

Run: `npm test -- test/cutover/no-legacy-identity.test.ts`  
Expected: PASS.

---

### Task 15: Full verification and migration acceptance

**Files:**
- Create: `test/e2e/alp-main.test.ts`
- Create: `test/e2e/alp-delegation.test.ts`
- Create: `test/e2e/memory-isolation.test.ts`
- Create: `test/e2e/runtime-selection.test.ts`
- Modify: `README.md`

**Step 1: Add end-to-end fixtures with fake runtime binaries**

Do not call paid/real models in CI. Fake Claude/Codex binaries capture argv, environment, prompt/config, tool authorization requests, and exit status.

**Step 2: Test main on both runtimes**

Assert `alp --runtime claude` and `alp --runtime codex` receive the same main identity/capabilities, with only runtime-specific launch syntax differing.

**Step 3: Test specialist delegation and memory isolation**

Assert main→search succeeds, search→review fails before spawn, main cannot read search private memory, and one execution cannot read another registered workspace.

**Step 4: Test memory portability**

Run the same `MemoryService` behavior against `MarkdownFileStore` and fake `RemoteApiStore`. Assert no agent code imports either concrete adapter.

**Step 5: Run all new checks**

```bash
npm run typecheck
npm run build
npm test
```

Expected: all pass.

**Step 6: Run retained legacy/cross-platform checks**

Run every still-applicable `scripts/test-*.cjs` test explicitly. Remove a legacy test only when its behavior has an equivalent new test and document the mapping in the final handoff.

Expected: all retained tests exit 0; removed tests have named replacements.

**Step 7: Run final static audits**

```bash
rg -n "CHARTER\.md|identity/|loadout\.yaml|AGENTS\.md|CLAUDE\.md|compile-acl|session-start" src scripts hooks
rg -n "child_process|spawn|exec" src/agents src/policy src/memory
git status --short
```

Expected:

- no runtime dependency on legacy identity sources;
- agents/policy/memory domain code does not spawn processes;
- only intended files changed;
- unrelated pre-existing deletions remain untouched.

**Step 8: Manual acceptance**

From a temporary registered project:

```bash
alp init --backend herdr
alp
alp --runtime claude
alp --runtime codex
alp delegate search --project "$PWD" -- "Find the entrypoint"
alp runtime show
alp doctor
```

Expected: runtime menu remembers the last choice, both runtimes receive main identity through capsules, delegation obeys policy, memory remains Markdown-backed, and the project contains no generated runtime identity config.

