import { createHash } from "node:crypto";
import { capabilityCatalog, type CapabilityCatalog } from "../agents/capability-catalog";
import { DEFAULT_MODE, modelForMode, reasoningEffortForMode, runtimeForMode, type ModeId, type ModeProfiles } from "../agents/modes";
import type { AgentDefinition, RuntimeId } from "../agents/types";
import { RUNTIME_IDS } from "../agents/types";
import { capabilitiesFor } from "../runtime/capabilities";
import type { ApprovalRecordV1 } from "./approvals";
import {
  deepFreezeExecutionValue,
  type ExecutionId,
  type ExecutionPolicy,
  type ExecutionThreadBinding,
} from "./types";

export interface CreateExecutionPolicyInput {
  readonly executionId: ExecutionId;
  /** Bắt buộc, kể cả khi `null` — xem `ExecutionPolicy.thread`. */
  readonly thread: ExecutionThreadBinding | null;
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
  /** What the principal said yes to for this launch; `[]` (the default) when nothing was asked. */
  readonly approvals?: readonly ApprovalRecordV1[];
  /** The approved write scope; absent or `null` means the whole workspace. */
  readonly writeScope?: readonly string[] | null;
  /** The approved exclusions; absent or `null` means none. */
  readonly excludeScope?: readonly string[] | null;
  /** The machine's toolchain write paths (GitHub #25); absent means none. */
  readonly toolchainWritePaths?: readonly string[];
  /** Defaults to the shipped catalog — see `capability-catalog.ts`. */
  readonly catalog?: CapabilityCatalog;
  /**
   * The platform the enforcement row is looked up for. Defaults to the process preparing the
   * execution; a re-derivation (the hook bridge) carries the snapshot's own value instead,
   * because the row is part of what was signed.
   */
  readonly platform?: NodeJS.Platform;
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

const THREAD_ID_PATTERN = /^thread_[A-Za-z0-9]+$/;
const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Binding phải là `null` tường minh hoặc đủ ba trường. `undefined` bị chặn ở đây chứ không
 * chỉ ở kiểu: một caller JavaScript quên field sẽ tạo ra policy trùng hash với legacy.
 */
function assertThreadBinding(value: ExecutionThreadBinding | null | undefined): ExecutionThreadBinding | null {
  if (value === null) return null;
  if (value === undefined) throw new Error("execution policy requires `thread` (use null when unthreaded)");
  if (typeof value.id !== "string" || !THREAD_ID_PATTERN.test(value.id)) {
    throw new Error(`invalid thread binding id \`${String(value.id)}\``);
  }
  if (!Number.isInteger(value.contextRevision) || value.contextRevision < 0) {
    throw new Error("thread binding contextRevision must be a non-negative integer");
  }
  if (typeof value.contextDigest !== "string" || !HEX_64.test(value.contextDigest)) {
    throw new Error("thread binding contextDigest must be a SHA-256 hex digest");
  }
  return { id: value.id, contextRevision: value.contextRevision, contextDigest: value.contextDigest };
}

/**
 * `writeScope` as a persisted snapshot carries it. Absent or `null` is "the whole workspace"
 * — every `policy.json` written before phase 2 reads that way; anything else must be a
 * non-empty list of non-empty strings, or the snapshot is not one this code wrote.
 */
export function readWriteScope(snapshot: Record<string, unknown>): readonly string[] | null {
  const value = snapshot.writeScope;
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new Error("policy snapshot `writeScope` must be a list of paths or null");
  if (value.length === 0) throw new Error("policy snapshot `writeScope` must not be empty; use null for the whole workspace");
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(`policy snapshot \`writeScope[${index}]\` must be a non-empty path`);
    }
  });
  return Object.freeze([...(value as string[])]);
}

/**
 * `excludeScope` as a persisted snapshot carries it. Absent or `null` is "nothing excluded"
 * — every `policy.json` written before master plan 2b reads that way; anything else must be
 * a non-empty list of non-empty strings, or the snapshot is not one this code wrote.
 */
export function readExcludeScope(snapshot: Record<string, unknown>): readonly string[] | null {
  const value = snapshot.excludeScope;
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new Error("policy snapshot `excludeScope` must be a list of paths or null");
  if (value.length === 0) throw new Error("policy snapshot `excludeScope` must not be empty; omit it when nothing is excluded");
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(`policy snapshot \`excludeScope[${index}]\` must be a non-empty path`);
    }
  });
  return Object.freeze([...(value as string[])]);
}

/**
 * `toolchainWritePaths` as a persisted snapshot carries it. Absent is `[]` — every
 * `policy.json` written before GitHub #25 reads that way; present, it must be a list of
 * non-empty strings, or the snapshot is not one this code wrote.
 */
export function readToolchainWritePaths(snapshot: Record<string, unknown>): readonly string[] {
  const value = snapshot.toolchainWritePaths;
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error("policy snapshot `toolchainWritePaths` must be a list of paths");
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(`policy snapshot \`toolchainWritePaths[${index}]\` must be a non-empty path`);
    }
  });
  return Object.freeze([...(value as string[])]);
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
  const runtime = runtimeForMode(input.definition, mode, input.modeProfiles);
  const snapshot = {
    executionId: input.executionId,
    thread: assertThreadBinding(input.thread),
    role: input.definition.id,
    workspace: input.workspace,
    workspaceMode: input.workspaceMode,
    // Trong snapshot chứ không trong `definitionHash`: nấc là lựa chọn lúc phóng, không phải
    // một vai khác. Definition không đổi, execution thì có.
    mode,
    model,
    reasoningEffort: reasoningEffortForMode(input.definition, mode, input.modeProfiles),
    runtime,
    // The measured row this execution is judged against, inside the hash: the same role on
    // two machines whose runtime refuses different things is two different policies, and
    // the evidence later reads this row rather than whatever the table says by then.
    enforcement: capabilitiesFor(runtime, input.platform ?? process.platform),
    // The principal's answers, inside the hash for the same reason the enforcement row is.
    approvals: (input.approvals ?? []).map((record) => ({ ...record })),
    // Sorted here as well as at authorization: the hash must not depend on the order a
    // caller happened to list the same scope in.
    writeScope: input.writeScope === undefined || input.writeScope === null ? null : [...input.writeScope].sort(),
    // Only when something is excluded (master plan 2b): `canonicalize()` drops `undefined`,
    // so a launch that excludes nothing hashes exactly like one from before exclusions.
    ...(input.excludeScope === undefined || input.excludeScope === null ? {} : { excludeScope: [...new Set(input.excludeScope)].sort() }),
    // Sorted and deduplicated for the same reason; `[]` rather than absent so the key is
    // always in the hash.
    toolchainWritePaths: [...new Set(input.toolchainWritePaths ?? [])].sort(),
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
