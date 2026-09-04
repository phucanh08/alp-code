import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkpointDigest, PIN_MAX_BYTES, readCheckpoint, seedCheckpoint, writeCheckpoint } from "../../src/context/checkpoint";
import type { ContinuityCheckpointV1, ContinuityPin } from "../../src/context/types";
import { removeTemporary } from "../support/temporary-root";

const binding = { executionId: "exec_abc123", policyHash: "policy-hash-1" };

function pin(overrides: Partial<ContinuityPin> = {}): ContinuityPin {
  return { id: "pin-1", text: "chose X over Y", source: "principal", createdAt: "2026-09-04T00:00:00.000Z", ...overrides };
}

const roots: string[] = [];
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "alp-checkpoint-"));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => removeTemporary(path)));
});

describe("seedCheckpoint", () => {
  it("starts with no pins and a digest that matches its own content", () => {
    const checkpoint = seedCheckpoint({ ...binding, objective: "find the launcher" });
    expect(checkpoint).toMatchObject({
      version: 1,
      runtime: null,
      objective: "find the launcher",
      decisions: [], constraints: [], openItems: [], nextActions: [],
    });
    const { integrity, ...rest } = checkpoint;
    expect(integrity.checkpointSha256).toBe(checkpointDigest(rest));
  });
});

describe("checkpointDigest", () => {
  it("is stable across key order", () => {
    const a = { version: 1 as const, executionId: "exec_a", policyHash: "p", runtime: null, createdAt: "t", updatedAt: "t", objective: null, decisions: [], constraints: [], openItems: [], nextActions: [] };
    const b = { objective: null, nextActions: [], openItems: [], constraints: [], decisions: [], updatedAt: "t", createdAt: "t", runtime: null, policyHash: "p", executionId: "exec_a", version: 1 as const };
    expect(checkpointDigest(a)).toBe(checkpointDigest(b));
  });

  it("changes when a pin's content changes", () => {
    const base = { version: 1 as const, executionId: "exec_a", policyHash: "p", runtime: null, createdAt: "t", updatedAt: "t", objective: null, decisions: [pin()], constraints: [], openItems: [], nextActions: [] };
    const changed = { ...base, decisions: [pin({ text: "chose Y over X" })] };
    expect(checkpointDigest(base)).not.toBe(checkpointDigest(changed));
  });
});

describe("writeCheckpoint / readCheckpoint", () => {
  it("round-trips a seeded checkpoint", async () => {
    const directory = await root();
    const file = join(directory, "checkpoint.json");
    const seeded = seedCheckpoint({ ...binding, objective: "find the launcher" });
    await writeCheckpoint(file, seeded);

    const result = await readCheckpoint(file, binding);
    expect(result).toMatchObject({ ok: true, value: seeded });
  });

  it("rejects a checkpoint with the wrong executionId", async () => {
    const directory = await root();
    const file = join(directory, "checkpoint.json");
    await writeCheckpoint(file, seedCheckpoint({ ...binding, objective: null }));

    const result = await readCheckpoint(file, { ...binding, executionId: "exec_other" });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("policy binding") });
  });

  it("rejects a checkpoint with the wrong policyHash — cross-execution policy binding", async () => {
    const directory = await root();
    const file = join(directory, "checkpoint.json");
    await writeCheckpoint(file, seedCheckpoint({ ...binding, objective: null }));

    const result = await readCheckpoint(file, { ...binding, policyHash: "different-policy" });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("policy binding") });
  });

  it("rejects bad version", async () => {
    const directory = await root();
    const file = join(directory, "checkpoint.json");
    const seeded = seedCheckpoint({ ...binding, objective: null });
    await writeFile(file, JSON.stringify({ ...seeded, version: 2 }));

    await expect(readCheckpoint(file, binding)).resolves.toMatchObject({ ok: false });
  });

  it("rejects bad executionId shape", async () => {
    const directory = await root();
    const file = join(directory, "checkpoint.json");
    const seeded = seedCheckpoint({ executionId: "not-an-exec-id", policyHash: binding.policyHash, objective: null });
    await writeFile(file, JSON.stringify(seeded));

    await expect(readCheckpoint(file, { ...binding, executionId: "not-an-exec-id" })).resolves.toMatchObject({ ok: false });
  });

  it("rejects a missing policyHash", async () => {
    const directory = await root();
    const file = join(directory, "checkpoint.json");
    const seeded = seedCheckpoint({ ...binding, objective: null });
    const { policyHash: _drop, ...withoutPolicyHash } = seeded;
    await writeFile(file, JSON.stringify(withoutPolicyHash));

    await expect(readCheckpoint(file, binding)).resolves.toMatchObject({ ok: false });
  });

  it("rejects a missing timestamp", async () => {
    const directory = await root();
    const file = join(directory, "checkpoint.json");
    const seeded = seedCheckpoint({ ...binding, objective: null });
    const { updatedAt: _drop, ...withoutUpdatedAt } = seeded;
    await writeFile(file, JSON.stringify(withoutUpdatedAt));

    await expect(readCheckpoint(file, binding)).resolves.toMatchObject({ ok: false });
  });

  it("fails closed when the digest does not match the content", async () => {
    const directory = await root();
    const file = join(directory, "checkpoint.json");
    const seeded = seedCheckpoint({ ...binding, objective: "find the launcher" });
    const tampered: ContinuityCheckpointV1 = { ...seeded, objective: "something else" };
    await writeFile(file, JSON.stringify(tampered));

    const result = await readCheckpoint(file, binding);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("digest") });
  });

  it("rejects an oversize pin and leaves any prior checkpoint on disk untouched", async () => {
    const directory = await root();
    const file = join(directory, "checkpoint.json");
    const good = seedCheckpoint({ ...binding, objective: null });
    await writeCheckpoint(file, good);
    const before = await readFile(file, "utf8");

    const oversizePin = pin({ id: "pin-oversize", text: "x".repeat(PIN_MAX_BYTES + 1) });
    await expect(writeCheckpoint(file, { ...good, decisions: [oversizePin] })).rejects.toThrow();

    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("rejects an oversize checkpoint as a whole", async () => {
    const directory = await root();
    const file = join(directory, "checkpoint.json");
    const good = seedCheckpoint({ ...binding, objective: null });
    const manyPins: ContinuityPin[] = Array.from({ length: 64 }, (_, index) =>
      pin({ id: `pin-${index}`, text: "y".repeat(PIN_MAX_BYTES) }));

    await expect(writeCheckpoint(file, { ...good, decisions: manyPins })).rejects.toThrow();
  });
});
