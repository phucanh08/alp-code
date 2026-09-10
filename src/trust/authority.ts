import type { AgentDefinition } from "../agents/types";

/**
 * The part of a definition a principal is actually approving when they trust it.
 *
 * Stored alongside the hash rather than derived from it, because a hash answers "did this
 * change" and never "what changed". §5.6 asks `alp agent add` to print a capability diff on
 * a re-trust, and a diff needs the previous authority, not a fingerprint of it. Kept to the
 * grants — the prompt is covered by the hash and shown in full on the same screen.
 */
export interface TrustedAuthority {
  readonly model: Readonly<Record<string, string>>;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly subagents: readonly string[];
  readonly mcpServers: readonly string[];
  readonly memoryRead: readonly string[];
  readonly memoryWrite: readonly string[];
  readonly workspaceRead: readonly string[];
  readonly workspaceWrite: readonly string[];
}

export function authorityOf(definition: AgentDefinition<unknown>): TrustedAuthority {
  const { capabilities } = definition;
  return {
    model: { ...definition.model },
    tools: [...capabilities.tools],
    skills: [...capabilities.skills],
    subagents: [...capabilities.subagents],
    mcpServers: [...capabilities.mcpServers],
    memoryRead: [...capabilities.memory.read],
    memoryWrite: [...capabilities.memory.write],
    workspaceRead: [...capabilities.workspace.readRoots],
    workspaceWrite: [...capabilities.workspace.writeRoots],
  };
}

const LABELS: Readonly<Record<keyof TrustedAuthority, string>> = Object.freeze({
  model: "model",
  tools: "tools",
  skills: "skills",
  subagents: "subagents",
  mcpServers: "mcp servers",
  memoryRead: "memory read",
  memoryWrite: "memory write",
  workspaceRead: "workspace read",
  workspaceWrite: "workspace write",
});

function listDiff(before: readonly string[], after: readonly string[]): string | null {
  const gained = after.filter((value) => !before.includes(value));
  const lost = before.filter((value) => !after.includes(value));
  if (gained.length === 0 && lost.length === 0) return null;
  return [
    ...gained.map((value) => `+${value}`),
    ...lost.map((value) => `-${value}`),
  ].join(" ");
}

/**
 * What changed between a trusted authority and the one on disk now.
 *
 * Gains are what matters — a grant the principal never approved — but losses are printed
 * too: an agent that quietly lost a tool is still a definition that changed underneath a
 * decision, and hiding half the diff would make the other half look like the whole story.
 */
export function diffAuthority(
  before: TrustedAuthority,
  after: TrustedAuthority,
): readonly string[] {
  const lines: string[] = [];
  for (const runtime of Object.keys({ ...before.model, ...after.model }).sort()) {
    const from = before.model[runtime] ?? "—";
    const to = after.model[runtime] ?? "—";
    if (from !== to) lines.push(`${LABELS.model} (${runtime}): ${from} → ${to}`);
  }
  for (const key of ["tools", "skills", "subagents", "mcpServers", "memoryRead", "memoryWrite", "workspaceRead", "workspaceWrite"] as const) {
    const changed = listDiff(before[key], after[key]);
    if (changed !== null) lines.push(`${LABELS[key]}: ${changed}`);
  }
  return lines;
}
