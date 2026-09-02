import { describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import type { AgentId, ToolId } from "../../src/agents/types";

const ROLE_IDS = [
  "main",
  "search",
  "librarian",
  "read-thread",
  "review",
  "oracle",
  "compaction",
  "titling",
] as const;

const ROUTING = {
  main: ["claude-opus-5", "gpt-5.6-sol", "high", "xhigh"],
  search: ["claude-sonnet-5", "gpt-5.6-terra", "low", "low"],
  librarian: ["claude-opus-5", "gpt-5.6-sol", "high", "high"],
  "read-thread": ["claude-haiku-4-5", "gpt-5.6-luna", "low", "low"],
  review: ["claude-opus-5", "gpt-5.5", "high", "medium"],
  oracle: ["claude-opus-5", "gpt-5.6-sol", "high", "xhigh"],
  compaction: ["claude-opus-5", "gpt-5.6-sol", "medium", "medium"],
  titling: ["claude-haiku-4-5", "gpt-5.6-luna", "low", "low"],
} as const;

const TOOLS: Record<(typeof ROLE_IDS)[number], readonly ToolId[]> = {
  main: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Skill"],
  search: ["Read", "Glob", "Grep", "Bash", "Skill"],
  librarian: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Skill"],
  "read-thread": ["Read", "Glob", "Grep", "Skill"],
  review: ["Read", "Glob", "Grep", "Bash", "Skill"],
  oracle: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Skill"],
  compaction: ["Read", "Glob", "Grep"],
  titling: [],
};

const OUTPUTS = {
  main: "principal-response",
  search: "code-search-result",
  librarian: "research-report",
  "read-thread": "memory-retrieval-result",
  review: "code-review-report",
  oracle: "architecture-advice",
  compaction: "context-handoff",
  titling: "thread-title",
} as const;

describe("code-native role definitions", () => {
  it("registers exactly the approved eight role IDs", () => {
    expect(agentRegistry.list().map(({ id }) => id)).toEqual(ROLE_IDS);
  });

  it.each(ROLE_IDS)("locks runtime models and reasoning effort for %s", (id) => {
    const definition = agentRegistry.get(id);
    const [claude, codex, claudeEffort, codexEffort] = ROUTING[id];

    expect(definition.model).toEqual({ claude, codex });
    expect(definition.reasoningEffort).toEqual({ claude: claudeEffort, codex: codexEffort });
  });

  it("locks the main-only delegation topology", () => {
    expect(agentRegistry.get("main").reportsTo).toBe("principal");
    expect(agentRegistry.get("main").delegatesTo).toEqual(ROLE_IDS.slice(1));
    for (const id of ROLE_IDS.slice(1)) {
      expect(agentRegistry.get(id).reportsTo).toBe("main");
      expect(agentRegistry.get(id).delegatesTo).toEqual([]);
    }
  });

  it.each(ROLE_IDS)("locks tool grants and output contract for %s", (id) => {
    const definition = agentRegistry.get(id);
    expect(definition.capabilities.tools).toEqual(TOOLS[id]);
    expect(definition.output.name).toBe(OUTPUTS[id]);
  });

  it("keeps specialist memory writes least-privileged and main unable to read them", () => {
    expect(agentRegistry.get("main").capabilities.memory).toEqual({
      read: ["shared", "project:*", "private:main"],
      write: ["shared", "project:*", "private:main"],
    });
    for (const id of ROLE_IDS.slice(1).filter((role) => role !== "librarian")) {
      const grants = agentRegistry.get(id).capabilities.memory;
      expect(grants.write).toEqual([`private:${id}`]);
      expect(agentRegistry.get("main").capabilities.memory.read).not.toContain(`private:${id}`);
    }
    expect(agentRegistry.get("librarian").capabilities.memory.write).toEqual([
      "shared:reference:*",
      "project:*:refs:*",
      "private:librarian",
    ]);
    expect(agentRegistry.get("librarian").capabilities.memory.write).not.toContain("shared");
    expect(agentRegistry.get("librarian").capabilities.memory.write).not.toContain("project:*");
    expect(agentRegistry.get("titling").capabilities.memory.read).toEqual(["private:titling"]);
    expect(agentRegistry.get("compaction").capabilities.memory.read).toEqual([
      "shared",
      "project:*",
      "private:compaction",
    ]);
  });

  it("gives titling one deterministic one-line workflow", () => {
    const titling = agentRegistry.get("titling");
    expect(titling.workflow).toMatchObject({ id: "title-thread", initial: "TITLE" });
    expect(Object.keys(titling.workflow.states)).toEqual(["TITLE"]);
    expect(titling.workflow.states.TITLE).toMatchObject({ terminal: true });
    expect(titling.output.validate("Tên thread ngắn")).toMatchObject({ ok: true });
    // Shape is now a role instruction rather than a schema: contracts accept any prose so
    // that roles answer in text. Emptiness is the only thing still rejected.
    expect(titling.output.validate("   ")).toMatchObject({ ok: false });
    expect(titling.capabilities.memory.read).not.toContain("shared");
    expect(titling.capabilities.memory.read.some((grant) => grant.startsWith("project:"))).toBe(false);
  });

  it.each(ROLE_IDS)("uses a deterministic workflow and a text output contract for %s", (id) => {
    const definition = agentRegistry.get(id);
    expect(definition.workflow.states[definition.workflow.initial]).toBeDefined();
    expect(definition.output.validate(null)).toMatchObject({ ok: false });
    expect(definition.output.validate("a prose answer")).toMatchObject({ ok: true });
  });

  it.each(ROLE_IDS)("renders static, task-free role instructions for %s", (id) => {
    const instructions = agentRegistry.get(id).instructions();
    expect(instructions.length).toBeGreaterThan(80);
    // Instructions must stay identical across executions — they are rendered once into
    // `.alp/agents/<role>.md` and injected by the SessionStart hook, so nothing
    // execution-specific may leak in.
    expect(instructions).toBe(agentRegistry.get(id).instructions());
  });

  it("returns frozen definitions and grants", () => {
    for (const definition of agentRegistry.list()) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.reasoningEffort)).toBe(true);
      expect(Object.isFrozen(definition.capabilities.tools)).toBe(true);
    }
  });
});
