import { describe, expect, it } from "vitest";
import { defineAgent } from "../../src/agents/agent-definition";
import { createAgentRegistry } from "../../src/agents/registry";
import type { AgentDefinition, AgentId, ToolId } from "../../src/agents/types";

function probe(
  overrides: Partial<AgentDefinition<unknown>> = {},
): AgentDefinition<unknown> {
  const id = (overrides.id ?? "probe") as AgentId;
  return {
    id,
    displayName: "Probe",
    model: { claude: "claude-probe", codex: "codex-probe" },
    reasoningEffort: { claude: "low", codex: "low" },
    reportsTo: "principal",
    delegatesTo: [],
    capabilities: {
      tools: ["Read"],
      memory: { read: ["shared"], write: [] },
      workspace: { readRoots: ["/workspace"], writeRoots: [] },
    },
    instructions: () => "Probe instructions",
    workflow: {
      id: "probe-workflow",
      initial: "REPORT",
      states: {
        REPORT: { allowedTools: [], transitions: [], terminal: true },
      },
    },
    output: { name: "probe-output", schema: {}, validate: () => ({ ok: true }) },
    ...overrides,
  };
}

describe("createAgentRegistry", () => {
  it("rejects duplicate role IDs", () => {
    expect(() =>
      createAgentRegistry([
        defineAgent(probe({ id: "probe" })),
        defineAgent(probe({ id: "probe" })),
      ]),
    ).toThrowError(/duplicate agent `probe`/);
  });

  it("requires reportsTo to point to a known role or principal", () => {
    expect(() =>
      createAgentRegistry([
        defineAgent(probe({ reportsTo: "missing" as AgentId })),
      ]),
    ).toThrowError(/unknown reportsTo `missing`/);
  });

  it("requires every delegation target to exist", () => {
    expect(() =>
      createAgentRegistry([
        defineAgent(probe({ delegatesTo: ["missing" as AgentId] })),
      ]),
    ).toThrowError(/unknown delegation target `missing`/);
  });

  it("rejects self-delegation", () => {
    expect(() =>
      createAgentRegistry([
        defineAgent(probe({ delegatesTo: ["probe"] })),
      ]),
    ).toThrowError(/cannot delegate to itself/);
  });

  it("rejects delegation cycles", () => {
    expect(() =>
      createAgentRegistry([
        defineAgent(
          probe({
            id: "parent",
            delegatesTo: ["child"],
          }),
        ),
        defineAgent(
          probe({
            id: "child",
            reportsTo: "parent",
            delegatesTo: ["parent"],
          }),
        ),
      ]),
    ).toThrowError(/delegation cycle.*parent.*child.*parent/);
  });

  it("requires workspace write roots to be readable", () => {
    expect(() =>
      createAgentRegistry([
        defineAgent(
          probe({
            capabilities: {
              ...probe().capabilities,
              workspace: {
                readRoots: ["/workspace/read"],
                writeRoots: ["/workspace/write"],
              },
            },
          }),
        ),
      ]),
    ).toThrowError(/workspace write root .* is not readable/);
  });

  it("allows workspace write roots nested under a readable root", () => {
    expect(() =>
      createAgentRegistry([
        defineAgent(
          probe({
            capabilities: {
              ...probe().capabilities,
              workspace: {
                readRoots: ["/workspace"],
                writeRoots: ["/workspace/output"],
              },
            },
          }),
        ),
      ]),
    ).not.toThrow();
  });

  it("requires memory write grants to be readable", () => {
    expect(() =>
      createAgentRegistry([
        defineAgent(
          probe({
            capabilities: {
              ...probe().capabilities,
              memory: { read: ["shared"], write: ["project:alp-code"] },
            },
          }),
        ),
      ]),
    ).toThrowError(/memory write grant .* is not readable/);
  });

  it("allows project writes covered by a project wildcard read grant", () => {
    expect(() =>
      createAgentRegistry([
        defineAgent(
          probe({
            capabilities: {
              ...probe().capabilities,
              memory: {
                read: ["project:*"],
                write: ["project:alp-code"],
              },
            },
          }),
        ),
      ]),
    ).not.toThrow();
  });

  it("rejects private-memory grants owned by another role", () => {
    expect(() =>
      createAgentRegistry([
        defineAgent(
          probe({
            capabilities: {
              ...probe().capabilities,
              memory: { read: ["private:other"], write: [] },
            },
          }),
        ),
      ]),
    ).toThrowError(/cannot access private memory for `other`/);
  });

  it("rejects tools outside the code-native catalog", () => {
    expect(() =>
      createAgentRegistry([
        defineAgent(
          probe({
            capabilities: {
              ...probe().capabilities,
              tools: ["UnknownTool" as ToolId],
            },
          }),
        ),
      ]),
    ).toThrowError(/unknown tool `UnknownTool`/);
  });

  it("rejects a missing Claude runtime model", () => {
    expect(() =>
      createAgentRegistry([
        defineAgent(probe({ model: { claude: "", codex: "codex-probe" } })),
      ]),
    ).toThrowError(/missing Claude runtime model/);
  });

  it("rejects a missing Codex runtime model", () => {
    expect(() =>
      createAgentRegistry([
        defineAgent(probe({ model: { claude: "claude-probe", codex: "" } })),
      ]),
    ).toThrowError(/missing Codex runtime model/);
  });

  it("returns immutable snapshots without exposing its internal list", () => {
    const input = probe();
    const registry = createAgentRegistry([defineAgent(input)]);
    const definition = registry.get("probe");
    const firstList = registry.list();

    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.delegatesTo)).toBe(true);
    expect(Object.isFrozen(definition.capabilities)).toBe(true);
    expect(Object.isFrozen(definition.capabilities.memory.read)).toBe(true);
    expect(Object.isFrozen(firstList)).toBe(true);
    expect(registry.list()).toBe(firstList);
    expect(() => registry.get("missing")).toThrowError(/unknown agent `missing`/);
  });
});
