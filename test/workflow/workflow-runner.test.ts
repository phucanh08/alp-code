import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineOutputContract } from "../../src/workflow/output-validator";
import { WorkflowRunner } from "../../src/workflow/workflow-runner";
import type { WorkflowDefinition } from "../../src/workflow/types";

const workflow: WorkflowDefinition = {
  id: "retrieve",
  initial: "RECEIVE",
  states: {
    RECEIVE: { allowedTools: [], transitions: ["RETRIEVE"] },
    RETRIEVE: { allowedTools: ["Read", "Grep"], transitions: ["REPORT"] },
    REPORT: { allowedTools: [], transitions: [], terminal: true },
  },
};

const output = defineOutputContract(
  "retrieval-result",
  z.object({
    status: z.enum(["found", "not-found"]),
    evidence: z.array(z.object({ path: z.string().min(1), line: z.number().int().positive() })),
  }),
);

describe("WorkflowRunner", () => {
  it("initializes serializable state and follows only declared transitions", () => {
    const runner = new WorkflowRunner();
    const initial = runner.initialize(workflow);

    expect(JSON.parse(JSON.stringify(initial))).toEqual(initial);
    expect(initial).toMatchObject({
      workflowId: "retrieve",
      currentState: "RECEIVE",
      status: "running",
      repairAttempts: 0,
    });
    expect(() => runner.transition(workflow, initial, "REPORT")).toThrowError(
      /transition `RECEIVE` -> `REPORT` is not declared/,
    );

    const retrieving = runner.transition(workflow, initial, "RETRIEVE");
    expect(retrieving.currentState).toBe("RETRIEVE");
    expect(runner.transition(workflow, retrieving, "REPORT")).toMatchObject({
      currentState: "REPORT",
      status: "awaiting-output",
    });
  });

  it("rejects malformed definitions and undeclared destination states", () => {
    const runner = new WorkflowRunner();
    expect(() =>
      runner.initialize({ id: "broken", initial: "MISSING", states: {} }),
    ).toThrowError(/unknown initial state `MISSING`/);

    expect(() =>
      runner.initialize({
        id: "broken",
        initial: "START",
        states: {
          START: { allowedTools: [], transitions: ["MISSING"] },
        },
      }),
    ).toThrowError(/unknown transition target `MISSING`/);
  });

  it("allows only the current state's declared tools", () => {
    const runner = new WorkflowRunner();
    const receiving = runner.initialize(workflow);
    const retrieving = runner.transition(workflow, receiving, "RETRIEVE");

    expect(runner.isToolAllowed(workflow, receiving, "Read")).toBe(false);
    expect(runner.isToolAllowed(workflow, retrieving, "Read")).toBe(true);
    expect(runner.isToolAllowed(workflow, retrieving, "Grep")).toBe(true);
    expect(runner.isToolAllowed(workflow, retrieving, "Bash")).toBe(false);
  });

  it("blocks transitions and tools after entering a terminal state", () => {
    const runner = new WorkflowRunner();
    const report = runner.transition(
      workflow,
      runner.transition(workflow, runner.initialize(workflow), "RETRIEVE"),
      "REPORT",
    );

    expect(runner.isToolAllowed(workflow, report, "Read")).toBe(false);
    expect(() => runner.transition(workflow, report, "REPORT")).toThrowError(
      /cannot transition workflow in `awaiting-output` status/,
    );
  });

  it("accepts valid structured output and completes the workflow", () => {
    const runner = new WorkflowRunner();
    const report = runner.transition(
      workflow,
      runner.transition(workflow, runner.initialize(workflow), "RETRIEVE"),
      "REPORT",
    );

    const result = runner.submitOutput(report, output, {
      status: "found",
      evidence: [{ path: "src/index.ts", line: 1 }],
    });

    expect(result.validation).toMatchObject({ ok: true });
    expect(result.state.status).toBe("completed");
  });

  it("permits exactly one repair before a second validation failure fails", () => {
    const runner = new WorkflowRunner();
    const report = runner.transition(
      workflow,
      runner.transition(workflow, runner.initialize(workflow), "RETRIEVE"),
      "REPORT",
    );

    const first = runner.submitOutput(report, output, {
      status: "found",
      evidence: [{ path: "src/index.ts", line: 0 }],
    });
    expect(first.validation).toMatchObject({ ok: false });
    expect(first.state).toMatchObject({ status: "repairing", repairAttempts: 1 });

    const second = runner.submitOutput(first.state, output, {
      status: "found",
      evidence: [{ path: "", line: 1 }],
    });
    expect(second.validation).toMatchObject({ ok: false });
    expect(second.state).toMatchObject({ status: "failed", repairAttempts: 1 });
    expect(() => runner.submitOutput(second.state, output, {})).toThrowError(
      /cannot submit output in `failed` status/,
    );
  });

  it("lets a repaired output complete without incrementing repair count again", () => {
    const runner = new WorkflowRunner();
    const report = runner.transition(
      workflow,
      runner.transition(workflow, runner.initialize(workflow), "RETRIEVE"),
      "REPORT",
    );
    const first = runner.submitOutput(report, output, {});
    const repaired = runner.submitOutput(first.state, output, {
      status: "not-found",
      evidence: [],
    });

    expect(repaired.validation).toMatchObject({ ok: true });
    expect(repaired.state).toMatchObject({ status: "completed", repairAttempts: 1 });
  });

  it("cancels active workflows and makes cancellation terminal", () => {
    const runner = new WorkflowRunner();
    const cancelled = runner.cancel(runner.initialize(workflow));

    expect(cancelled.status).toBe("cancelled");
    expect(() => runner.transition(workflow, cancelled, "RETRIEVE")).toThrowError(
      /cannot transition workflow in `cancelled` status/,
    );
    expect(() => runner.cancel(cancelled)).toThrowError(
      /cannot cancel workflow in `cancelled` status/,
    );
  });
});
