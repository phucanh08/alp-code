import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { agentRegistry } from "../agents/registry";
import type { AgentDefinition, AgentRegistry, MemoryScopeGrant, ToolId } from "../agents/types";
import { createExecutionPolicy } from "../execution/execution-policy";
import type { ExecutionPolicy, StoredExecutionState } from "../execution/types";
import { PolicyEngine } from "../policy/policy-engine";
import type { Authorization } from "../policy/types";
import { WorkflowRunner } from "../workflow/workflow-runner";
import type { WorkflowExecutionState } from "../workflow/types";

export interface HookExecutionInput {
  readonly executionId: string;
  readonly executionRoot?: string;
  readonly memoryRoot?: string;
  readonly skillRoots?: readonly string[];
}

export interface HookToolInput extends HookExecutionInput {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly cwd: string;
}

export interface FinalizeExecutionInput extends HookExecutionInput {
  readonly output: unknown;
}

export async function validateHookExecution(input: HookExecutionInput): Promise<{ executionId: string; role: string }> {
  const { policy } = await loadExecution(input);
  return { executionId: policy.executionId, role: policy.role };
}

type HookAuthorization = Authorization | { readonly allowed: false; readonly code: "INVALID_EXECUTION"; readonly reason: string };

function invalid(reason: string): HookAuthorization {
  return { allowed: false, code: "INVALID_EXECUTION", reason };
}

function executionRoot(input: HookExecutionInput): string {
  return input.executionRoot ?? process.env.ALP_EXECUTION_ROOT ?? join(process.env.HOME ?? "", ".alp", "executions");
}

function assertExecutionId(id: string): void {
  if (!/^exec_[a-zA-Z0-9_-]+$/.test(id)) throw new Error("missing or invalid execution ID");
}

async function loadExecution(input: HookExecutionInput): Promise<{
  policy: ExecutionPolicy;
  state: StoredExecutionState;
}> {
  assertExecutionId(input.executionId);
  const directory = join(executionRoot(input), input.executionId);
  const [policy, state] = await Promise.all([
    readFile(join(directory, "policy.json"), "utf8").then((value) => JSON.parse(value) as ExecutionPolicy),
    readFile(join(directory, "state.json"), "utf8").then((value) => JSON.parse(value) as StoredExecutionState),
  ]);
  if (policy.executionId !== input.executionId || state.executionId !== input.executionId) throw new Error("execution ID mismatch");
  if (state.policyHash !== policy.policyHash) throw new Error("execution state policy hash mismatch");
  const definition = agentRegistry.get(policy.role);
  const expected = createExecutionPolicy({
    executionId: policy.executionId,
    definition,
    workspace: policy.workspace,
    workspaceMode: policy.workspaceMode,
    createdAt: policy.createdAt,
  });
  if (JSON.stringify(expected) !== JSON.stringify(policy)) throw new Error("execution policy snapshot is invalid or stale");
  return { policy, state };
}

function within(root: string, target: string): boolean {
  const relation = relative(resolve(root), resolve(target));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function isRuntimeArtifact(input: HookExecutionInput, target: string): boolean {
  const root = join(executionRoot(input), input.executionId, "runtime");
  return within(canonicalPath(root), canonicalPath(target));
}

function isSkillArtifact(input: HookExecutionInput, target: string): boolean {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  let artifactRoots: string[] = [];
  try {
    const parsed = JSON.parse(readFileSync(join(executionRoot(input), input.executionId, "runtime", "skill-roots.json"), "utf8"));
    if (Array.isArray(parsed) && parsed.length <= 64 && parsed.every((value) => typeof value === "string" && isAbsolute(value))) {
      artifactRoots = parsed;
    }
  } catch { /* absence means no adapter-declared skill roots */ }
  const roots = input.skillRoots ?? [
    ...artifactRoots,
    ...(process.env.ALP_SKILL_ROOTS ?? "").split(delimiter),
    process.env.ALP_REPO_ROOT ? join(process.env.ALP_REPO_ROOT, "skills") : "",
    home ? join(home, ".agents", "skills") : "",
    process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "skills") : home ? join(home, ".codex", "skills") : "",
    process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, "skills") : home ? join(home, ".claude", "skills") : "",
  ].filter(Boolean);
  const logicalTarget = resolve(target);
  return roots.some((root) => within(resolve(root), logicalTarget));
}

function patchCandidates(command: unknown): string[] {
  if (typeof command !== "string") return [];
  return [...command.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm), ...command.matchAll(/^\*\*\* Move to:\s*(.+)$/gm)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function shellCandidates(command: unknown): string[] {
  if (typeof command !== "string") return [];
  const paths: string[] = [];
  for (const segment of command.split(/[;|&\n]+/)) {
    const tokens = segment.trim().split(/\s+/).map((token) => token.replace(/^['"]+|['"]+$/g, "").replace(/[,:]+$/, ""));
    for (const token of tokens) {
      if (!token.startsWith("-") && (token.includes("/") || token.startsWith(".") || token.startsWith("~"))) paths.push(token);
    }
  }
  for (const match of command.matchAll(/\d*[<>]{1,2}\s*("[^"]+"|'[^']+'|[^\s;|&<>]+)/g)) {
    paths.push(match[1].replace(/^['"]|['"]$/g, ""));
  }
  return paths;
}

function pathCandidates(tool: string, input: Readonly<Record<string, unknown>>): string[] {
  return [
    input.file_path,
    input.notebook_path,
    input.path,
    ...(tool === "apply_patch" ? patchCandidates(input.command) : []),
    ...(tool === "Bash" ? shellCandidates(input.command) : []),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function canonicalPath(value: string): string {
  const absolute = resolve(value);
  let candidate = absolute;
  const missing: string[] = [];
  while (true) {
    try { return join(realpathSync(candidate), ...missing); }
    catch {
      const parent = dirname(candidate);
      if (parent === candidate) return absolute;
      missing.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

type MemoryPathScope =
  | { readonly inside: false }
  | { readonly inside: true; readonly scope: MemoryScopeGrant | null };

function memoryScope(input: HookExecutionInput, target: string): MemoryPathScope {
  const rootValue = input.memoryRoot ?? process.env.ALP_MEMORY_ROOT;
  if (!rootValue) return { inside: false };
  const root = canonicalPath(rootValue);
  const canonicalTarget = canonicalPath(target);
  if (!within(root, canonicalTarget)) return { inside: false };
  const parts = relative(root, canonicalTarget).split(/[\\/]/).filter(Boolean);
  const head = parts[0];
  const tail = parts.slice(1);
  if (head === "shared") {
    if (tail.length === 0) return { inside: true, scope: "shared" };
    return { inside: true, scope: `shared:${tail.map((part) => part.replace(/\.md$/i, "")).join(":")}` };
  }
  if (head === "projects" && tail.length > 0 && !(tail.length === 1 && /\.md$/i.test(tail[0]))) {
    return { inside: true, scope: `project:${tail[0]}` };
  }
  if (head === "private" && tail.length > 0) {
    return { inside: true, scope: `private:${tail[0]}` };
  }
  return { inside: true, scope: null };
}

function isWriteCapableShell(command: string): boolean {
  const commandToken = "(?:^|[;&|()\\s])";
  const tokenEnd = "(?=\\s|$|[;&|()])";
  const directMutation = new RegExp(
    `${commandToken}(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|install|truncate|patch|tee)${tokenEnd}`,
    "i",
  );
  const gitMutation = new RegExp(
    `${commandToken}git\\s+(?:add|apply|checkout|clean|commit|merge|mv|rebase|reset|restore|rm|stash|switch)${tokenEnd}`,
    "i",
  );
  const packageMutation = new RegExp(
    `${commandToken}(?:npm|pnpm|yarn|bun)\\s+(?:add|install|remove|uninstall|update|upgrade)${tokenEnd}`,
    "i",
  );
  const outputRedirect = /(?:^|[^0-9<>])>{1,2}(?!&)/;
  const sedInPlace = new RegExp(`${commandToken}sed\\b[^;&|\\n]*?(?:^|\\s)-(?:[A-Za-z]*i|i(?:\\.[^\\s]+)?)(?=\\s|$)`, "i");
  const perlInPlace = new RegExp(`${commandToken}perl\\s+[^;&|\\n]*-(?:[A-Za-z]*i[A-Za-z]*)(?=\\s|$)`, "i");
  const ddOutput = new RegExp(`${commandToken}dd\\b[^;&|\\n]*\\bof=`, "i");
  return directMutation.test(command)
    || gitMutation.test(command)
    || packageMutation.test(command)
    || outputRedirect.test(command)
    || sedInPlace.test(command)
    || perlInPlace.test(command)
    || ddOutput.test(command);
}

function normalizedTool(tool: string, allowedTools: readonly ToolId[]): ToolId | null {
  if (tool === "apply_patch") {
    if (allowedTools.includes("Write")) return "Write";
    if (allowedTools.includes("Edit")) return "Edit";
    return null;
  }
  return allowedTools.includes(tool as ToolId) ? tool as ToolId : null;
}

function advanceForTool(
  runner: WorkflowRunner,
  definition: AgentDefinition<unknown>,
  state: WorkflowExecutionState,
  tool: ToolId,
): WorkflowExecutionState | null {
  let candidate = state;
  while (candidate.status === "running") {
    if (runner.isToolAllowed(definition.workflow, candidate, tool)) return candidate;
    const transitions = definition.workflow.states[candidate.currentState].transitions;
    if (transitions.length !== 1) return null;
    candidate = runner.transition(definition.workflow, candidate, transitions[0]);
  }
  return null;
}

function advanceToOutput(
  runner: WorkflowRunner,
  definition: AgentDefinition<unknown>,
  state: WorkflowExecutionState,
): WorkflowExecutionState {
  let candidate = state;
  while (candidate.status === "running") {
    const transitions = definition.workflow.states[candidate.currentState].transitions;
    if (transitions.length !== 1) throw new Error(`workflow state \`${candidate.currentState}\` has no unambiguous output path`);
    candidate = runner.transition(definition.workflow, candidate, transitions[0]);
  }
  return candidate;
}

function executionRegistry(policy: ExecutionPolicy): AgentRegistry {
  const definitions = agentRegistry.list().map((definition) => {
    if (definition.id !== policy.role) return definition;
    return Object.freeze({
      ...definition,
      capabilities: Object.freeze({
        ...definition.capabilities,
        workspace: Object.freeze({
          readRoots: Object.freeze([policy.workspace]),
          writeRoots: Object.freeze(policy.workspaceMode === "workspace-write" ? [policy.workspace] : []),
        }),
      }),
    }) as AgentDefinition<unknown>;
  });
  return Object.freeze({
    get(id: string) {
      const found = definitions.find((definition) => definition.id === id);
      if (!found) throw new Error(`unknown agent \`${id}\``);
      return found;
    },
    has(id: string) { return definitions.some((definition) => definition.id === id); },
    list() { return definitions; },
  });
}

export async function authorizeHookTool(input: HookToolInput): Promise<HookAuthorization> {
  try {
    const { policy, state } = await loadExecution(input);
    const definition = agentRegistry.get(policy.role);
    const engine = new PolicyEngine({ registry: executionRegistry(policy), canonicalizePath: canonicalPath });
    const toolId = normalizedTool(input.tool, policy.allowedTools);
    if (!toolId) return invalid(`tool \`${input.tool}\` is absent from immutable execution policy`);
    const tool = engine.authorize({
      type: "tool",
      actor: policy.role,
      tool: toolId,
      ...(toolId === "Bash" && typeof input.input.command === "string" ? { command: input.input.command } : {}),
    });
    if (!tool.allowed) return tool;
    const runner = new WorkflowRunner();
    const workflow = advanceForTool(runner, definition, state.workflow, toolId);
    if (!workflow) {
      return invalid(`tool \`${input.tool}\` is unavailable in workflow state \`${state.workflow.currentState}\``);
    }
    const operation = ["Write", "Edit"].includes(toolId) ? "write" : "read";
    const shellWrites = toolId === "Bash" && isWriteCapableShell(String(input.input.command ?? ""));
    const candidates = pathCandidates(input.tool, input.input);
    if (input.tool === "apply_patch" && candidates.length === 0) return invalid("apply_patch has no verifiable file target");
    for (const candidate of candidates) {
      const expanded = candidate.startsWith("~") ? join(process.env.HOME ?? "", candidate.slice(1)) : candidate;
      const target = resolve(input.cwd, expanded);
      if (!within(policy.workspace, target)) {
        if (operation === "read" && isRuntimeArtifact(input, target)) continue;
        if (operation === "read" && policy.allowedTools.includes("Skill") && isSkillArtifact(input, target)) {
          if (shellWrites) return invalid("write-capable shell command cannot target read-only skill artifacts");
          continue;
        }
        return invalid(`path \`${target}\` is outside the execution workspace`);
      }
      const memoryPath = memoryScope(input, target);
      if (memoryPath.inside) {
        if (!memoryPath.scope) return invalid(`memory path \`${target}\` has no authorized logical scope`);
        const memory = engine.authorize({ type: "memory", actor: policy.role, operation, scope: memoryPath.scope });
        if (!memory.allowed) return memory;
      }
      const authorization = engine.authorize({
        type: "workspace",
        actor: policy.role,
        operation,
        path: target,
        execution: { activeWorkspace: policy.workspace, workspaceMode: policy.workspaceMode, delegated: true },
      });
      if (!authorization.allowed) return authorization;
    }
    if (policy.workspaceMode === "read-only" && shellWrites) {
      return invalid("write-capable shell command is denied in a read-only execution");
    }
    if (workflow !== state.workflow) await persistState(input, { ...state, status: workflow.status, workflow });
    return { allowed: true };
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
}

async function persistState(input: HookExecutionInput, state: StoredExecutionState): Promise<void> {
  const file = join(executionRoot(input), input.executionId, "state.json");
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

export async function finalizeExecution(input: FinalizeExecutionInput): Promise<{ ok: boolean; status: string; issues: readonly string[] }> {
  const { policy, state } = await loadExecution(input);
  const definition = agentRegistry.get(policy.role);
  if (state.workflow.status === "completed") return { ok: true, status: "completed", issues: [] };
  if (state.workflow.status === "failed") return { ok: false, status: "failed", issues: ["output repair budget exhausted"] };
  const runner = new WorkflowRunner();
  const workflow = advanceToOutput(runner, definition, state.workflow);
  const result = runner.submitOutput(workflow, definition.output, input.output);
  await persistState(input, {
    ...state,
    status: result.state.status,
    workflow: result.state,
    ...(result.validation.ok ? { output: result.validation.value ?? input.output } : {}),
  });
  return {
    ok: result.validation.ok,
    status: result.state.status,
    issues: result.validation.ok ? [] : result.validation.issues,
  };
}

export function parseAssistantOutput(value: unknown): unknown {
  if (value !== null && typeof value === "object") return value;
  if (typeof value !== "string") throw new Error("last assistant message is missing");
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i)?.[1].trim() ?? trimmed;
  try { return JSON.parse(fenced); }
  catch { throw new Error("last assistant message is not valid JSON"); }
}
