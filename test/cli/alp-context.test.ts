import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runContextCommand, type ContextCommandDependencies } from "../../src/cli/commands/context";
import { seedCheckpoint, writeCheckpoint } from "../../src/context/checkpoint";
import { renderContinuity } from "../../src/context/continuity";
import { removeTemporary } from "../support/temporary-root";

const EXECUTION_ID = "exec_context_cli";
const POLICY_HASH = "policy-hash-abc";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => removeTemporary(root))));

interface Fixture {
  readonly executionsRoot: string;
  readonly checkpointFile: string;
  readonly continuityFile: string;
  readonly compactEventsFile: string;
}

async function fixture(objective: string | null = "find the launcher"): Promise<Fixture> {
  const executionsRoot = await mkdtemp(join(tmpdir(), "alp-context-cli-"));
  roots.push(executionsRoot);
  const directory = join(executionsRoot, EXECUTION_ID);
  const contextDirectory = join(directory, "context");
  await mkdir(contextDirectory, { recursive: true });
  await writeFile(join(directory, "policy.json"), JSON.stringify({ policyHash: POLICY_HASH }));

  const checkpointFile = join(contextDirectory, "checkpoint.json");
  const continuityFile = join(contextDirectory, "continuity.md");
  const compactEventsFile = join(contextDirectory, "compact-events.jsonl");
  const checkpoint = await writeCheckpoint(checkpointFile, seedCheckpoint({
    executionId: EXECUTION_ID,
    policyHash: POLICY_HASH,
    objective,
    now: () => "2026-09-04T00:00:00.000Z",
  }));
  await writeFile(continuityFile, renderContinuity(checkpoint));
  await writeFile(compactEventsFile, "");
  return { executionsRoot, checkpointFile, continuityFile, compactEventsFile };
}

interface TestDependencies extends ContextCommandDependencies {
  readonly writes: string[];
}

/**
 * `pin`/`unpin` only ever resolve the execution ID from the environment (plan §11), so the
 * default here carries it — tests exercising resolution itself, or its absence, override it.
 */
function deps(fixtureValue: Fixture, env: NodeJS.ProcessEnv = { ALP_DELEGATION_EXECUTION_ID: EXECUTION_ID }): TestDependencies {
  const writes: string[] = [];
  return {
    executionsRoot: fixtureValue.executionsRoot,
    env,
    write: (text) => writes.push(text),
    now: () => "2026-09-04T01:00:00.000Z",
    writes,
  };
}

function output(dependencies: TestDependencies): string {
  return dependencies.writes.join("");
}

describe("alp context status", () => {
  it("reports objective, pin counts, and an unknown restore mode with no journal activity", async () => {
    const value = await fixture();
    const dependencies = deps(value);

    const code = await runContextCommand(["status", EXECUTION_ID], dependencies);

    expect(code).toBe(0);
    const text = output(dependencies);
    expect(text).toContain(`EXECUTION  ${EXECUTION_ID}`);
    expect(text).toContain("OBJECTIVE  find the launcher");
    expect(text).toContain("decisions=0 constraints=0 open-items=0 next-actions=0");
    expect(text).toContain("GENERATION 0");
    expect(text).toContain("PENDING    (none)");
    expect(text).toContain("unknown — no compaction observed yet");
  });

  it("resolves the execution ID from ALP_DELEGATION_EXECUTION_ID when no positional is given", async () => {
    const value = await fixture();
    const dependencies = deps(value, { ALP_DELEGATION_EXECUTION_ID: EXECUTION_ID });

    expect(await runContextCommand(["status"], dependencies)).toBe(0);
    expect(output(dependencies)).toContain(EXECUTION_ID);
  });

  it("fails usage when no execution ID can be resolved", async () => {
    const value = await fixture();
    await expect(runContextCommand(["status"], deps(value, {}))).rejects.toThrow(/usage/);
  });

  it("warns instead of throwing when the checkpoint fails its policy binding", async () => {
    const value = await fixture();
    // A checkpoint bound to a different policy hash than policy.json now carries.
    await writeCheckpoint(value.checkpointFile, seedCheckpoint({
      executionId: EXECUTION_ID,
      policyHash: "a-different-hash",
      objective: "find the launcher",
    }));
    const dependencies = deps(value);

    const code = await runContextCommand(["status", EXECUTION_ID], dependencies);

    expect(code).toBe(0);
    expect(output(dependencies)).toContain("WARNING    checkpoint not usable");
  });

  it("reports dropped lines for a journal that contains garbage", async () => {
    const value = await fixture();
    await appendFile(value.compactEventsFile, "not json at all\n");
    const dependencies = deps(value);

    await runContextCommand(["status", EXECUTION_ID], dependencies);

    expect(output(dependencies)).toContain("1 line(s) that failed to parse");
  });

  it("reports generation and pending/completed from a real journal pair", async () => {
    const value = await fixture();
    const pre = JSON.stringify({
      v: 1, at: "2026-09-04T00:00:01.000Z", executionId: EXECUTION_ID, policyHash: POLICY_HASH,
      runtime: "claude", phase: "pre", source: { session_id: "s1", trigger: "manual", prompt_id: "p1" },
    });
    const post = JSON.stringify({
      v: 1, at: "2026-09-04T00:00:02.000Z", executionId: EXECUTION_ID, policyHash: POLICY_HASH,
      runtime: "claude", phase: "post", source: { session_id: "s1", trigger: "manual", prompt_id: "p1" },
    });
    await writeFile(value.compactEventsFile, `${pre}\n${post}\n`);
    const dependencies = deps(value);

    await runContextCommand(["status", EXECUTION_ID], dependencies);

    const text = output(dependencies);
    expect(text).toContain("GENERATION 1");
    expect(text).toContain("PENDING    (none)");
    expect(text).toContain("COMPLETED  claude manual");
    expect(text).toContain("reinjected at the next SessionStart");
  });
});

describe("alp context validate", () => {
  it("passes a healthy checkpoint and journal", async () => {
    const value = await fixture();
    const dependencies = deps(value);

    const code = await runContextCommand(["validate", EXECUTION_ID], dependencies);

    expect(code).toBe(0);
    expect(output(dependencies)).toContain("CHECKPOINT valid");
  });

  it("fails when the checkpoint cannot be trusted", async () => {
    const value = await fixture();
    await writeFile(value.checkpointFile, "{ not json");
    const dependencies = deps(value);

    const code = await runContextCommand(["validate", EXECUTION_ID], dependencies);

    expect(code).toBe(1);
    expect(output(dependencies)).toContain("INVALID");
  });
});

describe("alp context pin/unpin", () => {
  it("adds a principal pin and re-renders continuity in the same call", async () => {
    const value = await fixture();
    const dependencies = deps(value);

    const code = await runContextCommand(["pin", "decision", "--", "chose", "X", "over", "Y"], dependencies);

    expect(code).toBe(0);
    expect(output(dependencies)).toMatch(/PINNED\s+[0-9a-f-]+/);
    const checkpoint = JSON.parse(await readFile(value.checkpointFile, "utf8"));
    expect(checkpoint.decisions).toHaveLength(1);
    expect(checkpoint.decisions[0]).toMatchObject({ text: "chose X over Y", source: "principal" });
    expect(await readFile(value.continuityFile, "utf8")).toContain("chose X over Y");
  });

  it("tags a pin from a delegated role as source: agent", async () => {
    const value = await fixture();
    const dependencies = deps(value, { ALP_DELEGATION_EXECUTION_ID: EXECUTION_ID, ALP_DELEGATED_ROLE: "search" });

    await runContextCommand(["pin", "constraint", "--", "do not touch Z"], dependencies);

    const checkpoint = JSON.parse(await readFile(value.checkpointFile, "utf8"));
    expect(checkpoint.constraints[0]).toMatchObject({ text: "do not touch Z", source: "agent" });
  });

  it("collapses control characters so a pin stays one line", async () => {
    const value = await fixture();
    const dependencies = deps(value);

    await runContextCommand(["pin", "open-item", "--", "line one\nline\ttwo"], dependencies);

    const checkpoint = JSON.parse(await readFile(value.checkpointFile, "utf8"));
    expect(checkpoint.openItems[0].text).toBe("line one line two");
  });

  it("rejects an oversize pin without writing anything", async () => {
    const value = await fixture();
    const dependencies = deps(value);
    const before = await readFile(value.checkpointFile, "utf8");

    await expect(runContextCommand(["pin", "next-action", "--", "x".repeat(5000)], dependencies))
      .rejects.toThrow(/exceeds/);

    expect(await readFile(value.checkpointFile, "utf8")).toBe(before);
  });

  it("rejects an empty or unknown pin kind", async () => {
    const value = await fixture();
    await expect(runContextCommand(["pin", "not-a-kind", "--", "text"], deps(value))).rejects.toThrow(/usage/);
    await expect(runContextCommand(["pin", "decision", "--", "   "], deps(value))).rejects.toThrow(/empty/);
  });

  it("removes a pin by ID and rerenders continuity without it", async () => {
    const value = await fixture();
    const dependencies = deps(value);
    await runContextCommand(["pin", "decision", "--", "chose X"], dependencies);
    const checkpoint = JSON.parse(await readFile(value.checkpointFile, "utf8"));
    const pinId = checkpoint.decisions[0].id;

    const code = await runContextCommand(["unpin", pinId], dependencies);

    expect(code).toBe(0);
    const after = JSON.parse(await readFile(value.checkpointFile, "utf8"));
    expect(after.decisions).toHaveLength(0);
    expect(await readFile(value.continuityFile, "utf8")).not.toContain("chose X");
  });

  it("leaves the checkpoint untouched when the pin ID does not exist", async () => {
    const value = await fixture();
    const dependencies = deps(value);
    await runContextCommand(["pin", "decision", "--", "chose X"], dependencies);
    const before = await readFile(value.checkpointFile, "utf8");

    await expect(runContextCommand(["unpin", "no-such-id"], dependencies)).rejects.toThrow(/no pin/);

    expect(await readFile(value.checkpointFile, "utf8")).toBe(before);
  });

  it("resolves execution ID from the environment for pin, with no positional slot for it", async () => {
    const value = await fixture();
    const dependencies = deps(value, { ALP_DELEGATION_EXECUTION_ID: EXECUTION_ID });

    expect(await runContextCommand(["pin", "decision", "--", "chose X"], dependencies)).toBe(0);
  });

  it("never touches the compact-events journal", async () => {
    const value = await fixture();
    const before = await readFile(value.compactEventsFile, "utf8");
    const dependencies = deps(value);

    await runContextCommand(["pin", "decision", "--", "chose X"], dependencies);

    expect(await readFile(value.compactEventsFile, "utf8")).toBe(before);
  });
});
