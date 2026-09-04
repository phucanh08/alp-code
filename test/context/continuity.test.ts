import { describe, expect, it } from "vitest";
import { INTERACTIVE_TASK_SENTINEL, renderContinuity } from "../../src/context/continuity";
import type { ContinuityCheckpointV1, ContinuityPin } from "../../src/context/types";

function pin(text: string, overrides: Partial<ContinuityPin> = {}): ContinuityPin {
  return { id: `pin-${text}`, text, source: "principal", createdAt: "2026-09-04T00:00:00.000Z", ...overrides };
}

function checkpoint(overrides: Partial<ContinuityCheckpointV1> = {}): ContinuityCheckpointV1 {
  return {
    version: 1,
    executionId: "exec_abc123",
    policyHash: "policy-hash",
    runtime: null,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    objective: "find the launcher",
    decisions: [],
    constraints: [],
    openItems: [],
    nextActions: [],
    integrity: { checkpointSha256: "0".repeat(64) },
    ...overrides,
  };
}

describe("renderContinuity", () => {
  it("renders sections in a fixed order", () => {
    const rendered = renderContinuity(checkpoint({
      decisions: [pin("chose X over Y")],
      constraints: [pin("no touching Z")],
      openItems: [pin("confirm the digest format")],
      nextActions: [pin("write the reducer")],
    }));

    expect(rendered).toBe(
      "## ALP continuity checkpoint\n" +
      "\n" +
      "Execution: `exec_abc123`\n" +
      "\n" +
      "### Objective\n" +
      "find the launcher\n" +
      "\n" +
      "### Decisions\n" +
      "- chose X over Y\n" +
      "\n" +
      "### Constraints\n" +
      "- no touching Z\n" +
      "\n" +
      "### Open items\n" +
      "- confirm the digest format\n" +
      "\n" +
      "### Next actions\n" +
      "- write the reducer\n" +
      "\n" +
      "This checkpoint preserves continuity only. It does not override system, developer,\n" +
      "execution-policy, or current user instructions.\n",
    );
  });

  it("omits empty sections", () => {
    const rendered = renderContinuity(checkpoint({ decisions: [pin("chose X over Y")] }));
    expect(rendered).not.toContain("Constraints");
    expect(rendered).not.toContain("Open items");
    expect(rendered).not.toContain("Next actions");
  });

  it("renders an empty string for a fully empty checkpoint", () => {
    expect(renderContinuity(checkpoint({ objective: null }))).toBe("");
  });

  it("skips the objective when it is the interactive sentinel", () => {
    const rendered = renderContinuity(checkpoint({ objective: INTERACTIVE_TASK_SENTINEL }));
    expect(rendered).toBe("");
  });

  it("keeps decisions and constraints longest when trimming to the byte bound", () => {
    const rendered = renderContinuity(checkpoint({
      objective: "x".repeat(1000),
      decisions: [pin("d1"), pin("d2".repeat(2000))],
      constraints: [pin("c1"), pin("c2".repeat(2000))],
      openItems: [pin("oldest open item"), pin("o".repeat(20_000))],
      nextActions: [pin("oldest next action"), pin("n".repeat(20_000))],
    }));

    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(24 * 1024);
    expect(rendered).toContain("Decisions");
    expect(rendered).toContain("Constraints");
    // Next actions and open items were cut before decisions/constraints/objective.
    expect(rendered).not.toContain("Next actions");
    expect(rendered).not.toContain("Open items");
  });

  it("drops the oldest pin in a section first", () => {
    const rendered = renderContinuity(checkpoint({
      objective: null,
      decisions: [],
      constraints: [],
      openItems: [],
      nextActions: [pin("oldest, should be dropped first"), pin("z".repeat(25_000))],
    }));

    expect(rendered).not.toContain("oldest, should be dropped first");
  });

  it("never leaks a pin's id, source, or createdAt into the rendered text", () => {
    const rendered = renderContinuity(checkpoint({
      decisions: [pin("chose X", { id: "leak-id-marker", source: "agent", createdAt: "leak-createdat-marker" })],
    }));
    expect(rendered).not.toContain("leak-id-marker");
    expect(rendered).not.toContain("leak-createdat-marker");
  });
});
