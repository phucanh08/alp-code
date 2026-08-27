# Code-native Agent Identity Architecture

**Status:** Approved by principal on 2026-08-26  
**Scope:** Replace Markdown/YAML runtime identity with TypeScript agent definitions, a code-enforced policy engine, selectable Claude/Codex runtimes, and a storage-neutral memory module.

## Goals

- Make ALP the only supported entrypoint for every agent session.
- Replace `CHARTER.md`, `identity/**`, `AGENTS.md`, `CLAUDE.md`, and `loadout.yaml` with code-native definitions.
- Move authorization, workflow transitions, and output contracts out of prompts and into TypeScript.
- Let `alp` choose Claude or Codex interactively, remember the last choice, and support non-interactive flags.
- Introduce a `MemoryStore` interface backed by Markdown files today and a remote API later.
- Preserve current role topology, memory isolation, workspace isolation, and delegation lifecycle.

## Non-goals

- Eliminate natural-language instructions entirely. LLMs still need a system instruction, but its source becomes TypeScript rather than Markdown.
- Move memory content to a server in this migration.
- Support identity-aware sessions started by raw `claude` or `codex` commands.
- Add automatic runtime fallback after a process has started.
- Add automatic remote-memory-to-local-file write fallback.

## Core Decisions

1. TypeScript is the source of truth for identity and policy.
2. ALP is the only supported launcher; raw runtime commands have no ALP identity.
3. An identity has two halves:
   - semantic identity: system instructions built from code;
   - enforced identity: immutable execution policy checked outside the model.
4. Every launch creates an identity capsule and policy snapshot tied to an execution ID.
5. Role workflows and output contracts are executable code, not prose conventions.
6. Memory access goes exclusively through `MemoryService`.
7. Current memory remains Markdown through `MarkdownFileStore`.
8. Future server storage implements the same `MemoryStore` contract.
9. Runtime selection is persisted as user state, not as identity source.

## Target Layout

```text
src/
├── agents/
│   ├── agent-definition.ts
│   ├── registry.ts
│   ├── main.ts
│   ├── search.ts
│   ├── librarian.ts
│   ├── read-thread.ts
│   ├── review.ts
│   ├── oracle.ts
│   ├── compaction.ts
│   └── titling.ts
├── policy/
│   ├── policy-engine.ts
│   ├── invariants.ts
│   ├── delegation-policy.ts
│   ├── memory-policy.ts
│   └── workspace-policy.ts
├── memory/
│   ├── memory-entry.ts
│   ├── memory-store.ts
│   ├── memory-service.ts
│   └── adapters/
│       ├── markdown-file-store.ts
│       └── remote-api-store.ts
├── workflow/
│   ├── workflow.ts
│   ├── workflow-runner.ts
│   └── output-validator.ts
├── execution/
│   ├── identity-capsule.ts
│   ├── execution-policy.ts
│   ├── execution-service.ts
│   └── execution-store.ts
├── runtime/
│   ├── runtime-adapter.ts
│   ├── runtime-selector.ts
│   ├── claude-adapter.ts
│   └── codex-adapter.ts
├── backend/
│   ├── execution-backend.ts
│   ├── local-process-backend.ts
│   ├── herdr-backend.ts
│   └── paseo-backend.ts
└── cli/
    └── alp.ts
```

## Agent Definition

Every role is a typed, immutable definition:

```ts
export interface AgentDefinition<TOutput> {
  readonly id: AgentId;
  readonly displayName: string;
  readonly model: RuntimeModelMap;
  readonly reportsTo: AgentId | "principal";
  readonly delegatesTo: readonly AgentId[];
  readonly capabilities: AgentCapabilities;
  readonly instructions: (context: InstructionContext) => string;
  readonly workflow: WorkflowDefinition;
  readonly output: OutputContract<TOutput>;
}
```

The registry rejects duplicate IDs, unknown relations, delegation cycles, write grants outside read grants, private-memory grants for another role, unknown tools, and missing runtime models.

## Identity Reception

The model does not discover identity from files. ALP selects and packages identity before launch:

```text
CLI request
  → AgentRegistry.get(target)
  → PolicyEngine.authorize(parent, target, workspace)
  → MemoryService.buildContext(target, task)
  → WorkflowRunner.initialize(target.workflow)
  → IdentityCapsule.create(...)
  → RuntimeAdapter.launch(capsule)
```

The capsule contains semantic instructions, task, allowed context, tool names, workspace, workflow state, and the ID of an immutable execution policy snapshot. Each tool request is authorized against that snapshot.

## Execution Policy

```ts
export interface ExecutionPolicy {
  readonly executionId: ExecutionId;
  readonly role: AgentId;
  readonly workspace: string;
  readonly workspaceMode: "read-only" | "workspace-write";
  readonly allowedTools: readonly ToolId[];
  readonly memory: MemoryGrant;
  readonly delegatesTo: readonly AgentId[];
  readonly createdAt: string;
  readonly definitionHash: string;
}
```

Policy state lives below `~/.alp/executions/<execution-id>/`. Runtime adapters may create temporary native configuration there, but project repositories receive no identity config. The launched sandbox cannot write policy state.

## Workflow Enforcement

Workflows use explicit states and transitions. For example:

```text
Search:
RECEIVE_TASK → VALIDATE_WORKSPACE → RETRIEVE_CODE
             → VERIFY_EVIDENCE → VALIDATE_OUTPUT → COMPLETE
```

The runner decides which tools and transitions are valid in each state. Prose instructions explain intent; code determines authorization and completion.

Each role has a structured output contract. Invalid output gets at most one repair attempt. A second failure makes the execution fail visibly.

## Runtime Selection

Calling `alp` presents a Claude/Codex menu. The last interactive choice is highlighted and Enter reuses it.

```bash
alp
alp --runtime claude
alp --runtime codex
alp runtime show
alp runtime set codex
```

Resolution order:

```text
explicit --runtime
  > interactive selection
  > persisted user preference
  > Claude default
```

The preference is stored below `~/.alp/` and is independent of backend selection. Runtime means Claude versus Codex; backend means Herdr versus Paseo.

No runtime fallback occurs after spawn is attempted because it could execute a task twice.

## Memory Architecture

```text
Agent workflow
  → MemoryService
      → MemoryPolicy
      → MemoryStore
          ├── MarkdownFileStore
          └── RemoteApiStore
```

Public memory identifiers are logical IDs, not filesystem paths:

```ts
export interface MemoryEntry {
  readonly id: string;
  readonly scope: "shared" | "project" | "private";
  readonly ownerRole?: AgentId;
  readonly projectId?: string;
  readonly kind: "fact" | "decision" | "reference" | "log" | "draft";
  readonly content: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoryStore {
  search(query: MemoryQuery): Promise<readonly MemoryEntry[]>;
  get(id: string): Promise<MemoryEntry | null>;
  create(input: CreateMemoryInput): Promise<MemoryEntry>;
  update(id: string, input: UpdateMemoryInput): Promise<MemoryEntry>;
  delete(id: string, expectedVersion: number): Promise<void>;
}
```

`MemoryService` enforces role grants, ownership, project scope, validation, context budgets, and audit records. `MarkdownFileStore` performs atomic file writes and optimistic version checks. `RemoteApiStore` is introduced as a contract test double initially and connected to a real API later.

Remote write failures fail clearly. There is no automatic local write fallback because that would create split-brain memory. A future local cache may be read-only.

## Runtime Adapters

Runtime and backend are orthogonal. Runtime means Claude versus Codex and owns command/config
translation. Backend means local process, Herdr, or Paseo and owns process/session lifecycle.

`ClaudeAdapter` and `CodexAdapter` implement one contract:

```ts
export interface RuntimeAdapter {
  readonly name: "claude" | "codex";
  probe(): Promise<RuntimeHealth>;
  prepare(input: PreparedAgentExecution): Promise<RuntimeLaunchSpec>;
}
```

Adapters translate the same identity capsule into runtime-specific commands and temporary config. They do not decide identity, policy, memory visibility, workflow, or process lifecycle. An execution backend receives the resulting `RuntimeLaunchSpec` and implements `spawn`, `wait`, `cancel`, and `cleanup`. Interactive `alp` uses the local-process backend; delegated work uses the configured Herdr/Paseo backend.

## Failure Behavior

- Unknown identity: fail before runtime selection.
- Unauthorized delegation: fail before backend health or spawn.
- Missing runtime: print a deterministic remediation command; do not switch runtime.
- Policy engine error: fail closed and deny the tool request.
- Context over budget: MemoryService ranks and trims memory; policy invariants are never trimmed.
- Invalid output: one repair attempt, then `failed`.
- Memory version conflict: return a typed conflict; do not overwrite.
- Runtime failure after spawn: record `failed`; do not fallback.
- Cleanup failure: retain execution metadata and report the orphan.

## Migration Strategy

Use a strangler migration. The current system remains runnable until parity is proven.

1. Add TypeScript build and characterization tests.
2. Implement core types, registry, policies, and memory interfaces.
3. Route current Markdown memory through `MemoryService`.
4. Port roles one by one, beginning with `titling`, `search`, then `main`.
5. Add runtime selection and adapters.
6. Rewire DelegationService to code-native definitions.
7. Switch `alp` and `alp init` to the new execution path.
8. Run parity, isolation, cross-platform, and end-to-end tests.
9. Remove Markdown/YAML identity and legacy compilers only after the new path is green.

## Removal Set

After cutover:

- remove `CHARTER.md`;
- remove `identity/**`;
- remove repository and nested `AGENTS.md`/`CLAUDE.md` identity entrypoints;
- remove `loadout.yaml` parsing and ACL compilation;
- remove Markdown `SessionStart` assembly;
- stop creating project `.claude/settings.local.json` and `.codex/config.toml`;
- keep human documentation outside the runtime path;
- keep Markdown memory data behind `MarkdownFileStore`.

## Verification

- Registry invariant tests.
- Policy allow/deny matrix tests for every role.
- MemoryStore contract tests shared by file and remote adapters.
- Atomic write and version-conflict tests.
- Workflow transition and output-repair tests.
- Runtime selector persistence and flag-precedence tests.
- Claude/Codex adapter command tests on macOS/Linux/Windows.
- Delegation policy and lifecycle tests.
- End-to-end `alp`, `alp init`, and `alp delegate` tests.
- Negative tests proving raw runtime launch has no ALP identity.

## Accepted Trade-offs

- Identity changes require a code change and build instead of editing Markdown.
- ALP becomes a mandatory availability boundary for all identity-aware sessions.
- Runtime adapters remain necessary because Claude and Codex expose different launch/config surfaces.
- File memory and future API memory must obey the same conservative consistency contract.
