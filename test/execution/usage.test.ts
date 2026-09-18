import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  accumulateUsage,
  addUsage,
  evaluateBudget,
  NO_USAGE,
  parseBudget,
  readExecutionUsage,
  sumUsage,
  totalTokens,
  usageFile,
  writeExecutionUsage,
  type ExecutionUsageV1,
  type UsageCounters,
} from "../../src/execution/usage";
import { removeTemporary } from "../support/temporary-root";

/**
 * Oracle: plan P6 (`phase-6-usage.md` §"Contract") + `research/transcript-usage.md`:
 * bốn cột token tách riêng, `null` = không biết và không biết thì không bao giờ thành 0;
 * budget quan sát, `exceeded` chỉ khi số đã biết vượt trần, thiếu số → `unknown`.
 */
const counters = (partial: Partial<UsageCounters>): UsageCounters => ({ ...NO_USAGE, ...partial });

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removeTemporary)); });

describe("addUsage / accumulateUsage", () => {
  it("adds every column independently", () => {
    const sum = addUsage(
      counters({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, toolCalls: 5 }),
      counters({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, toolCalls: 50 }),
    );
    expect(sum).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44, toolCalls: 55 });
  });

  it("keeps a column unknown once either side is unknown — never coerces null to 0", () => {
    const sum = addUsage(counters({ inputTokens: null, toolCalls: 2 }), counters({ inputTokens: 5, toolCalls: null }));
    expect(sum.inputTokens).toBeNull();
    expect(sum.toolCalls).toBeNull();
    expect(sum.outputTokens).toBe(0);
  });

  it("accumulates: nothing-yet + delta = delta; a delta of null (transcript unreadable) leaves the total alone", () => {
    const delta = counters({ inputTokens: 7, toolCalls: 1 });
    expect(accumulateUsage(null, delta)).toEqual(delta);
    expect(accumulateUsage(delta, null)).toEqual(delta);
    expect(accumulateUsage(delta, undefined)).toEqual(delta);
    expect(accumulateUsage(null, null)).toBeNull();
    expect(accumulateUsage(delta, counters({ inputTokens: 3, toolCalls: 2 }))).toEqual(counters({ inputTokens: 10, toolCalls: 3 }));
  });
});

describe("sumUsage / totalTokens", () => {
  it("totals the token columns and refuses a total with an unknown column", () => {
    expect(totalTokens(counters({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, toolCalls: 99 }))).toBe(10);
    expect(totalTokens(counters({ cacheReadTokens: null }))).toBeNull();
    expect(totalTokens(null)).toBeNull();
  });

  it("sums a tree's nodes and says `partial` when any node or column is unknown", () => {
    const known = sumUsage([counters({ inputTokens: 1, toolCalls: 1 }), counters({ inputTokens: 2, toolCalls: 0 })]);
    expect(known).toEqual({ usage: counters({ inputTokens: 3, toolCalls: 1 }), partial: false });
    const withNull = sumUsage([counters({ inputTokens: 1 }), null]);
    expect(withNull).toEqual({ usage: counters({ inputTokens: 1 }), partial: true });
    const withColumn = sumUsage([counters({ inputTokens: 1 }), counters({ inputTokens: null, outputTokens: 4 })]);
    expect(withColumn).toEqual({ usage: counters({ inputTokens: 1, outputTokens: 4 }), partial: true });
    expect(sumUsage([])).toEqual({ usage: NO_USAGE, partial: false });
  });
});

describe("evaluateBudget", () => {
  const full = counters({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 50, toolCalls: 3 });

  it("is `within` without a budget, whatever the usage", () => {
    expect(evaluateBudget(null, full)).toBe("within");
    expect(evaluateBudget(null, null)).toBe("within");
    expect(evaluateBudget({}, null)).toBe("within");
  });

  it("compares the token ceiling against every processed token — cache included — and the tool ceiling against tool calls", () => {
    expect(evaluateBudget({ tokens: 1000 }, full)).toBe("within");
    expect(evaluateBudget({ tokens: 999 }, full)).toBe("exceeded");
    // Exactly at the ceiling is still within.
    expect(evaluateBudget({ toolCalls: 3 }, full)).toBe("within");
    expect(evaluateBudget({ toolCalls: 2 }, full)).toBe("exceeded");
    // Both set: any one over is over.
    expect(evaluateBudget({ tokens: 5000, toolCalls: 2 }, full)).toBe("exceeded");
  });

  it("is `unknown` when the column the ceiling needs is unknown, but `exceeded` beats `unknown`", () => {
    expect(evaluateBudget({ tokens: 10 }, null)).toBe("unknown");
    expect(evaluateBudget({ tokens: 10 }, counters({ ...full, cacheReadTokens: null }))).toBe("unknown");
    expect(evaluateBudget({ toolCalls: 10 }, counters({ ...full, toolCalls: null }))).toBe("unknown");
    // A ceiling on tokens ignores an unknown tool column.
    expect(evaluateBudget({ tokens: 5000 }, counters({ ...full, toolCalls: null }))).toBe("within");
    expect(evaluateBudget({ tokens: 10, toolCalls: 10 }, counters({ ...full, toolCalls: null }))).toBe("exceeded");
  });
});

describe("parseBudget", () => {
  it("normalizes positive integers and drops an empty budget to null", () => {
    expect(parseBudget({ tokens: 10, toolCalls: 2 })).toEqual({ tokens: 10, toolCalls: 2 });
    expect(parseBudget({ tokens: 10 })).toEqual({ tokens: 10 });
    expect(parseBudget({ toolCalls: 1 })).toEqual({ toolCalls: 1 });
    expect(parseBudget({})).toBeNull();
    expect(parseBudget(undefined)).toBeNull();
    expect(parseBudget({ tokens: undefined })).toBeNull();
  });

  it("refuses zero, negatives, fractions, NaN, and non-numbers", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "10", null, true]) {
      expect(() => parseBudget({ tokens: bad as number }), String(bad)).toThrow(/budget\.tokens/);
      expect(() => parseBudget({ toolCalls: bad as number }), String(bad)).toThrow(/budget\.toolCalls/);
    }
  });
});

describe("usage.json", () => {
  it("round-trips under `<execution>/usage.json`, absent → null, other version refused", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-usage-"));
    roots.push(root);
    expect(usageFile(root, "exec_1")).toBe(join(root, "exec_1", "usage.json"));
    expect(await readExecutionUsage(root, "exec_1")).toBeNull();
    const record: ExecutionUsageV1 = {
      version: 1, executionId: "exec_1", source: "history-bridge", completeness: "complete", collectedAt: "2026-09-17T10:00:00.000Z",
      inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: null, toolCalls: 4,
    };
    await writeExecutionUsage(root, record);
    expect(await readExecutionUsage(root, "exec_1")).toEqual(record);
    expect(JSON.parse(await readFile(usageFile(root, "exec_1"), "utf8"))).toEqual(record);
    await writeExecutionUsage(root, { ...record, version: 2 as unknown as 1 });
    await expect(readExecutionUsage(root, "exec_1")).rejects.toThrow(/version 1/);
  });
});
