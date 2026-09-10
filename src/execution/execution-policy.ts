import { createHash } from "node:crypto";
import { capabilityCatalog, type CapabilityCatalog } from "../agents/capability-catalog";
import { DEFAULT_MODE, modelForMode, reasoningEffortForMode, runtimeForMode, type ModeId, type ModeProfiles } from "../agents/modes";
import type { AgentDefinition, RuntimeId } from "../agents/types";
import { RUNTIME_IDS } from "../agents/types";
import {
  deepFreezeExecutionValue,
  type ExecutionId,
  type ExecutionPolicy,
} from "./types";

export interface CreateExecutionPolicyInput {
  readonly executionId: ExecutionId;
  readonly definition: AgentDefinition<unknown>;
  readonly workspace: string;
  readonly workspaceMode: "read-only" | "workspace-write";
  /** Nấc công suất; bỏ trống thì `DEFAULT_MODE`. */
  readonly mode?: ModeId;
  /**
   * Loadout của nấc sau khi ghép `settings.json` của máy và của project. Bỏ trống thì bản
   * built-in — nấc nói gì thì vai chạy đúng thế.
   */
  readonly modeProfiles?: ModeProfiles;
  readonly createdAt: string;
  /** Defaults to the shipped catalog — see `capability-catalog.ts`. */
  readonly catalog?: CapabilityCatalog;
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "function") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

/**
 * The declared budget with one entry per runtime, present or not. Normalised in one place so
 * the hash cannot move just because a definition spelled the same budget with a key missing
 * rather than set to nothing.
 */
function declaredAutoCompactTokens(
  definition: AgentDefinition<unknown>,
): Readonly<Record<RuntimeId, number | null>> {
  return Object.fromEntries(
    RUNTIME_IDS.map((runtime) => [runtime, definition.autoCompactTokens?.[runtime] ?? null]),
  ) as Record<RuntimeId, number | null>;
}

export function hashAgentDefinition(
  definition: AgentDefinition<unknown>,
): string {
  return sha256({
    id: definition.id,
    displayName: definition.displayName,
    model: definition.model,
    reasoningEffort: definition.reasoningEffort,
    reportsTo: definition.reportsTo,
    delegatesTo: definition.delegatesTo,
    capabilities: definition.capabilities,
    autoCompactTokens: declaredAutoCompactTokens(definition),
    instructions: definition.instructions,
    workflow: definition.workflow,
    output: {
      name: definition.output.name,
      schema: definition.output.schema,
      validate: definition.output.validate,
    },
  });
}

export function createExecutionPolicy(
  input: CreateExecutionPolicyInput,
): ExecutionPolicy {
  const definitionHash = hashAgentDefinition(input.definition);
  const catalog = input.catalog ?? capabilityCatalog;
  const capabilities = input.definition.capabilities;
  // Names were checked against this catalog at registry load; a miss here would mean the
  // catalog changed underneath a definition, and an execution is not the place to find out.
  const resolve = <TEntry>(
    kind: string,
    names: readonly string[],
    entries: Readonly<Record<string, TEntry>>,
  ): readonly (TEntry & { readonly name: string })[] => names.map((name) => {
    const entry = entries[name];
    if (entry === undefined) {
      throw new Error(`unknown ${kind} \`${name}\` granted to \`${input.definition.id}\``);
    }
    return { name, ...entry };
  });
  const mode = input.mode ?? DEFAULT_MODE;
  // Giải một lần, ở đây, rồi cả launch đọc lại từ snapshot. Trước đây mỗi nơi phóng tự tra
  // lại bảng nấc; với settings thì "tra lại" nghĩa là có thể tra ra kết quả khác cái đã ký,
  // và `policy.json` sẽ mô tả một execution khác execution đang chạy.
  const model = modelForMode(input.definition, mode, input.modeProfiles);
  const snapshot = {
    executionId: input.executionId,
    role: input.definition.id,
    workspace: input.workspace,
    workspaceMode: input.workspaceMode,
    // Trong snapshot chứ không trong `definitionHash`: nấc là lựa chọn lúc phóng, không phải
    // một vai khác. Definition không đổi, execution thì có.
    mode,
    model,
    reasoningEffort: reasoningEffortForMode(input.definition, mode, input.modeProfiles),
    runtime: runtimeForMode(input.definition, mode, input.modeProfiles),
    workspaceAccess: input.definition.capabilities.workspace.readRoots.length > 0
      ? "granted" as const
      : "none" as const,
    allowedTools: [...capabilities.tools],
    skills: [...capabilities.skills],
    skillRoots: [...(capabilities.skillRoots ?? [])],
    subagents: resolve("subagent", capabilities.subagents, catalog.subagents),
    mcpServers: resolve("mcp server", capabilities.mcpServers, catalog.mcpServers),
    autoCompactTokens: declaredAutoCompactTokens(input.definition),
    memory: {
      read: [...input.definition.capabilities.memory.read],
      write: [...input.definition.capabilities.memory.write],
    },
    delegatesTo: [...input.definition.delegatesTo],
    createdAt: input.createdAt,
    definitionHash,
  };
  return deepFreezeExecutionValue({
    ...snapshot,
    policyHash: sha256(snapshot),
  });
}
