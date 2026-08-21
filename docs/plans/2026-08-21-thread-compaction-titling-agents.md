# Thread Compaction and Titling Agents Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Compaction and Titling as main-only Codex roles and make model reasoning effort an explicit, tested loadout setting for them, Search, and Review.

**Architecture:** Keep model and `reasoning_effort` together in each role's `loadout.yaml`. Extend the shared validator and Codex launcher to validate and apply effort, create both roles through `scripts/new-role.sh`, and document their main-only routing and output contracts.

**Tech Stack:** Node.js CommonJS, Bash/PowerShell launchers, Markdown identity files, YAML-subset loadouts, generated Claude ACL settings.

**Design:** `docs/plans/2026-08-21-thread-compaction-titling-agents-design.md`

---

### Task 1: Validate reasoning effort in loadouts

**Files:**
- Create: `scripts/test-loadout-models.cjs`
- Modify: `scripts/lib/loadout.cjs`

**Step 1: Write the failing test**

Create `scripts/test-loadout-models.cjs` using Node's built-in `assert`. Verify that:

```js
const valid = base({ model: "gpt-5.6-sol", reasoning_effort: "medium" });
assert.deepStrictEqual(L.validate(valid, "probe", ["probe", "main"]), []);

const invalid = base({ model: "gpt-5.6-sol", reasoning_effort: "turbo" });
assert(L.validate(invalid, "probe", ["probe", "main"])
  .some((message) => message.includes("reasoning_effort")));
```

The `base` helper returns a minimal valid loadout with `role: probe`, `name: Probe`,
`reports_to: main`, empty delegates, a memory block, and empty tools/workspaces.

**Step 2: Run the test to verify RED**

Run: `node scripts/test-loadout-models.cjs`

Expected: FAIL because `turbo` is currently accepted.

**Step 3: Implement minimal validation**

In `scripts/lib/loadout.cjs`, define and export:

```js
const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
```

In `validate`, reject a present value not included in that list:

```js
if (loadout.reasoning_effort && !REASONING_EFFORTS.includes(loadout.reasoning_effort))
  add(`\`reasoning_effort: ${loadout.reasoning_effort}\` không hợp lệ`);
```

**Step 4: Run GREEN verification**

Run: `node scripts/test-loadout-models.cjs`

Expected: `OK               loadout model tests passed`.

**Step 5: Commit**

```bash
git add scripts/lib/loadout.cjs scripts/test-loadout-models.cjs
git commit -m "feat: validate Codex reasoning effort"
```

### Task 2: Create Compaction and Titling through the canonical role generator

**Files:**
- Create through generator: `identity/compaction/**`
- Create through generator: `identity/titling/**`
- Create through generator: `memory/private/compaction/.gitkeep`
- Create through generator: `memory/private/titling/.gitkeep`
- Modify through generator: `identity/REGISTRY.md`
- Modify: `identity/main/loadout.yaml`

**Step 1: Run the canonical generator for Compaction**

Run:

```bash
scripts/new-role.sh compaction --name Compaction --emoji 🗜️ --model gpt-5.6-sol
```

Expected: the generator creates the role, private silo, registry row, and recompiles ACL.
`doctor` may exit non-zero because generated semantic placeholders have not yet been replaced
and because of the known project/trust warnings; do not rerun the generator.

**Step 2: Run the canonical generator for Titling**

Run:

```bash
scripts/new-role.sh titling --name Titling --emoji 🏷️ --model gpt-5.6-luna
```

Expected: equivalent scaffolding for Titling and ACL regeneration for all eight roles.

**Step 3: Replace Compaction's generated semantic files**

Use `apply_patch` to replace `IDENTITY.md`, `SOUL.md`, `PLAYBOOK.md`, and `RELATIONS.md` with
the approved role contract:

- runtime/model: Codex / `gpt-5.6-sol`;
- purpose: continuation-ready context summarization for long threads;
- preserve facts, uncertainty, decisions, exact anchors, and next actions;
- do not continue the task, research, write memory, or address the principal;
- output sections: Objective, Constraints, Decisions, Completed/current state, Open items,
  Next actions, Exact anchors;
- report only to `main`, never delegate.

Set `identity/compaction/loadout.yaml` to:

```yaml
model: gpt-5.6-sol
reasoning_effort: medium
reports_to: main
delegates_to: []
memory:
  read:  [shared/**, projects/**]
  write: []
workspaces:
  read:  []
  write: []
tools:  [Read, Glob, Grep]
skills: [agent-memory]
```

Keep the generated main-only clauses in `AGENTS.md` and `CLAUDE.md`.

**Step 4: Replace Titling's generated semantic files**

Use `apply_patch` with this contract:

- runtime/model: Codex / `gpt-5.6-luna`;
- purpose: one fast title for a thread;
- infer the primary intent, use the thread's main language, and return one short line;
- no quotes, label, explanation, alternatives, trailing punctuation, task execution, memory
  writes, or principal communication;
- report only to `main`, never delegate.

Set `identity/titling/loadout.yaml` to:

```yaml
model: gpt-5.6-luna
reasoning_effort: low
reports_to: main
delegates_to: []
memory:
  read:  []
  write: []
workspaces:
  read:  []
  write: []
tools:  []
skills: []
```

**Step 5: Route main to both roles and set existing efforts**

Add `compaction` and `titling` to `identity/main/loadout.yaml` `delegates_to`.

Add:

```yaml
reasoning_effort: low
```

to `identity/search/loadout.yaml`, and:

```yaml
reasoning_effort: medium
```

to `identity/review/loadout.yaml`.

**Step 6: Recompile and check placeholders**

Run:

```bash
scripts/compile-acl.sh
rg -n '<[^>]+>|\{\{[^}]+\}\}' identity/compaction identity/titling
```

Expected: ACL generation succeeds and `rg` returns no semantic/template placeholders.

**Step 7: Commit**

```bash
git add identity memory/private/compaction/.gitkeep memory/private/titling/.gitkeep
git commit -m "feat: add compaction and titling roles"
```

### Task 3: Apply effort and role routing in the Codex launcher

**Files:**
- Create: `scripts/lib/codex-role.cjs`
- Create: `scripts/test-codex-role.cjs`
- Modify: `scripts/run-role.cjs`

**Step 1: Write failing launcher-policy tests**

Create `scripts/test-codex-role.cjs` asserting the wished-for API:

```js
const C = require("./lib/codex-role.cjs");

assert(C.isAllowedRole("compaction"));
assert(C.isAllowedRole("titling"));
assert(C.isAllowedRole("review"));
assert(!C.isAllowedRole("main"));
assert.deepStrictEqual(C.reasoningArgs({ reasoning_effort: "medium" }), [
  "-c", 'model_reasoning_effort="medium"',
]);
assert.deepStrictEqual(C.reasoningArgs({}), []);
```

**Step 2: Run the test to verify RED**

Run: `node scripts/test-codex-role.cjs`

Expected: FAIL because `scripts/lib/codex-role.cjs` does not exist.

**Step 3: Implement the launcher policy helper**

Create the helper with the allowed set:

```js
const ALLOWED_ROLES = new Set([
  "search", "librarian", "read-thread", "review", "oracle", "compaction", "titling",
]);

const isAllowedRole = (role) => ALLOWED_ROLES.has(role);
const reasoningArgs = (loadout) => loadout.reasoning_effort
  ? ["-c", `model_reasoning_effort="${loadout.reasoning_effort}"`]
  : [];

module.exports = { ALLOWED_ROLES, isAllowedRole, reasoningArgs };
```

**Step 4: Integrate the helper into `scripts/run-role.cjs`**

- Replace the hardcoded three-role set with `isAllowedRole`.
- Insert `...reasoningArgs(loadout)` into the Codex CLI args.
- Add `reasoningEffort: loadout.reasoning_effort || null` to dry-run JSON.
- Include effort in the injected boot summary.
- Update usage text to list all accepted roles.

**Step 5: Run GREEN and real dry-run checks**

Run:

```bash
node scripts/test-codex-role.cjs
scripts/run-role.sh compaction --dry-run -- "Compact this thread"
scripts/run-role.sh titling --dry-run -- "Title this thread"
scripts/run-role.sh search --project "$PWD" --dry-run -- "Find a symbol"
scripts/run-role.sh review --project "$PWD" --dry-run -- "Review correctness"
```

Expected model/effort pairs:

- Compaction: `gpt-5.6-sol` / `medium`
- Titling: `gpt-5.6-luna` / `low`
- Search: `gpt-5.6-terra` / `low`
- Review: `gpt-5.5` / `medium`

**Step 6: Commit**

```bash
git add scripts/lib/codex-role.cjs scripts/test-codex-role.cjs scripts/run-role.cjs
git commit -m "feat: route Codex roles with configured effort"
```

### Task 4: Add system-level routing tests

**Files:**
- Create: `scripts/test-agent-routing.cjs`
- Create: `scripts/test-agent-routing.sh`
- Modify: `README.md`

**Step 1: Write the system test**

Create a Node test that loads real loadouts and verifies:

```js
const expected = {
  compaction: ["gpt-5.6-sol", "medium"],
  titling: ["gpt-5.6-luna", "low"],
  search: ["gpt-5.6-terra", "low"],
  review: ["gpt-5.5", "medium"],
};
```

For each role, assert `model`, `reasoning_effort`, `reports_to: main`, no delegates for
subordinates, and successful `run-role.sh <role> --dry-run` JSON. Pass `--project repoRoot`
for Search and Review. Also assert `main.delegates_to` contains Compaction and Titling.

**Step 2: Run the system test**

Run: `node scripts/test-agent-routing.cjs`

Expected: `OK               agent routing tests passed`.

**Step 3: Add the Bash wrapper and README script row**

Create `scripts/test-agent-routing.sh` as a two-line Node wrapper matching the existing test
wrappers. Add it to the README scripts table.

**Step 4: Commit**

```bash
git add scripts/test-agent-routing.cjs scripts/test-agent-routing.sh README.md
git commit -m "test: cover agent model routing"
```

### Task 5: Update roster and routing documentation

**Files:**
- Modify: `README.md`
- Modify: `CHARTER.md`
- Modify: `identity/REGISTRY.md`
- Modify: `identity/main/RELATIONS.md`
- Modify: `docs/model-routing.md`

**Step 1: Update role rosters**

Add Compaction and Titling to README, CHARTER, Registry, and Main Relations. Include their
model/effort and main-only output contracts. Label Search as Terra/low and Review as
GPT-5.5/medium.

**Step 2: Update model routing guidance**

In `docs/model-routing.md`:

- add long-thread context compaction → Sol/medium;
- add fast thread titling → Luna/low;
- record Search → Terra/low and Review → GPT-5.5/medium;
- update launcher examples to show `model_reasoning_effort` is normally derived from loadout.

**Step 3: Check generated registry and docs consistency**

Run:

```bash
scripts/doctor.sh --quiet
rg -n 'compaction|titling|reasoning_effort' README.md CHARTER.md identity docs/model-routing.md
```

Expected: no `REGISTRY-*`, `COMMS-*`, `IDENTITY-*`, `TEMPLATE-*`, or `ACL-*` signals. Known
project-layer/trust warnings may remain.

**Step 4: Commit**

```bash
git add README.md CHARTER.md identity/REGISTRY.md identity/main/RELATIONS.md docs/model-routing.md
git commit -m "docs: document compaction and titling routing"
```

### Task 6: Verify ACL isolation and complete the branch

**Files:**
- Modify only if verification reveals a defect covered by a new failing test.

**Step 1: Run all focused tests**

```bash
node scripts/test-loadout-models.cjs
node scripts/test-codex-role.cjs
scripts/test-agent-routing.sh
scripts/test-communication.sh
node scripts/test-delegation.cjs
```

Expected: all print `OK` and exit 0.

**Step 2: Run system checks**

```bash
scripts/compile-acl.sh --check
scripts/test-isolation.sh
scripts/doctor.sh
git diff --check
```

Expected: ACL matches all eight roles; isolation remains `20/20`; doctor has no new role,
communication, registry, template, or ACL errors. Record known project/trust warnings.

**Step 3: Review the full change**

Compare the feature branch with its main-branch merge base. Verify the approved design line by
line, inspect generated-role output rather than trusting `new-role.sh`, and apply only findings
backed by code or failing tests.

Use `superpowers:requesting-code-review` without spawning an agent when multi-agent execution
is not authorized, then use `superpowers:verification-before-completion`.

**Step 4: Integrate locally**

After fresh verification, use `superpowers:finishing-a-development-branch`. The principal's
established preference for this task is to run through completion; merge locally into `main`,
rerun focused tests on the merged result, and remove the feature worktree/branch. Do not push.
