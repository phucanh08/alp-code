import { describe, expect, it } from "vitest";
import {
  ambiguousNodes,
  bridgeProvenance,
  demoteForVersion,
  diffBaseline,
  evaluateEvidence,
  evidenceDigest,
  gitProvenance,
  outsideScope,
  parseRequiredEvidence,
  type EvidenceItem,
  type GitBaselineV1,
  type OverlapNode,
} from "../../src/execution/evidence";

/**
 * Oracle: P3 spec (`phase-3-evidence.md`), "Provenance" table — git is `observed` only when
 * nobody else could have written *and* the runtime refuses writes outside the sandbox; any
 * doubt on either side is `derived`; no baseline at all (not a git repo) is `unknown`.
 */
describe("gitProvenance", () => {
  it("is observed only with a baseline, no overlap, and enforced write isolation", () => {
    expect(gitProvenance({ baseline: true, ambiguousWith: [], writeIsolation: "enforced" })).toBe("observed");
  });

  it("drops to derived when another execution could have written, or the sandbox is not enforced", () => {
    expect(gitProvenance({ baseline: true, ambiguousWith: ["exec_other"], writeIsolation: "enforced" })).toBe("derived");
    for (const level of ["partial", "declared-only", "none", null] as const) {
      expect(gitProvenance({ baseline: true, ambiguousWith: [], writeIsolation: level })).toBe("derived");
    }
  });

  it("is unknown without a baseline, whatever else is true", () => {
    expect(gitProvenance({ baseline: false, ambiguousWith: [], writeIsolation: "enforced" })).toBe("unknown");
  });
});

describe("bridgeProvenance", () => {
  it("maps completeness to provenance row by row", () => {
    expect(bridgeProvenance("complete")).toBe("observed");
    expect(bridgeProvenance("partial")).toBe("derived");
    expect(bridgeProvenance("final-only")).toBe("derived");
    expect(bridgeProvenance("unsupported")).toBe("unknown");
  });
});

/**
 * Oracle: spec adversarial row — a runtime whose version is not the one the enforcement
 * table was measured on may not claim `observed`; and `versionMatchesMeasured` semantics
 * from P1 (`2.1.269` matches a table measured on `2.1`, `2.2.0` does not, `unknown` never).
 */
describe("demoteForVersion", () => {
  it("keeps observed when the launched version matches the measured one", () => {
    expect(demoteForVersion("observed", "2.1", "2.1.269")).toBe("observed");
  });

  it("lowers observed to derived on a mismatch, an unknown version, or no receipt", () => {
    expect(demoteForVersion("observed", "2.1", "2.2.0")).toBe("derived");
    expect(demoteForVersion("observed", "2.1", "unknown")).toBe("derived");
    expect(demoteForVersion("observed", "2.1", null)).toBe("derived");
  });

  it("never changes anything below observed", () => {
    for (const provenance of ["derived", "self-reported", "unknown"] as const) {
      expect(demoteForVersion(provenance, "2.1", "2.2.0")).toBe(provenance);
    }
  });
});

/**
 * Oracle: spec "Overlap" — another node is ambiguous with C when it shares C's workspace,
 * its active interval intersects C's, and either it is workspace-write with a scope not
 * disjoint from C's, or its runtime does not enforce write isolation. A sandboxed read-only
 * root is excluded even though it is active the whole time; a Windows root always counts.
 */
describe("ambiguousNodes", () => {
  const child: OverlapNode = {
    executionId: "exec_c",
    workspace: "/ws",
    workspaceMode: "workspace-write",
    writeScope: ["/ws/src"],
    writeIsolation: "enforced",
    startedAt: "2026-09-17T10:00:00.000Z",
    endedAt: "2026-09-17T10:10:00.000Z",
  };
  const node = (overrides: Partial<OverlapNode>): OverlapNode => ({
    executionId: "exec_n",
    workspace: "/ws",
    workspaceMode: "workspace-write",
    writeScope: null,
    writeIsolation: "enforced",
    startedAt: "2026-09-17T10:05:00.000Z",
    endedAt: null,
    ...overrides,
  });

  it("names a parallel writer in the same workspace whose scope touches C's", () => {
    expect(ambiguousNodes(child, [node({})])).toEqual(["exec_n"]);
    expect(ambiguousNodes(child, [node({ writeScope: ["/ws/src/lib"] })])).toEqual(["exec_n"]);
    expect(ambiguousNodes(child, [node({ writeScope: ["/ws"] })])).toEqual(["exec_n"]);
  });

  it("excludes a sandboxed writer whose scope is disjoint from C's", () => {
    expect(ambiguousNodes(child, [node({ writeScope: ["/ws/docs"] })])).toEqual([]);
    // `/ws/src-old` is beside `/ws/src`, not inside it.
    expect(ambiguousNodes(child, [node({ writeScope: ["/ws/src-old"] })])).toEqual([]);
  });

  it("includes a disjoint-scope writer whose runtime does not enforce isolation", () => {
    for (const level of ["partial", "declared-only", "none", null] as const) {
      expect(ambiguousNodes(child, [node({ writeScope: ["/ws/docs"], writeIsolation: level })])).toEqual(["exec_n"]);
    }
  });

  it("excludes a node whose interval does not intersect C's", () => {
    expect(ambiguousNodes(child, [node({ startedAt: "2026-09-17T09:00:00.000Z", endedAt: "2026-09-17T09:59:59.000Z" })])).toEqual([]);
    expect(ambiguousNodes(child, [node({ startedAt: "2026-09-17T10:10:00.001Z", endedAt: null })])).toEqual([]);
    // Touching at the boundary is an intersection — closed intervals.
    expect(ambiguousNodes(child, [node({ startedAt: "2026-09-17T09:00:00.000Z", endedAt: "2026-09-17T10:00:00.000Z" })])).toEqual(["exec_n"]);
  });

  it("excludes another workspace, and includes a workspace that contains or is inside C's", () => {
    expect(ambiguousNodes(child, [node({ workspace: "/other" })])).toEqual([]);
    expect(ambiguousNodes(child, [node({ workspace: "/ws-2" })])).toEqual([]);
    expect(ambiguousNodes(child, [node({ workspace: "/" , writeScope: null })])).toEqual(["exec_n"]);
    expect(ambiguousNodes(child, [node({ workspace: "/ws/src/lib" })])).toEqual(["exec_n"]);
  });

  it("excludes a writer whose exclusion carves out the meeting point (master plan 2b)", () => {
    // N owns all of `/ws` but excluded `/ws/src`, which is exactly what C owns.
    expect(ambiguousNodes(child, [node({ excludeScope: ["/ws/src"] })])).toEqual([]);
    // C's own exclusion counts too.
    expect(ambiguousNodes({ ...child, excludeScope: ["/ws/src/lib"] }, [node({ writeScope: ["/ws/src/lib"] })])).toEqual([]);
    // An exclusion that leaves part of the meeting point shared still names N.
    expect(ambiguousNodes(child, [node({ excludeScope: ["/ws/src/lib"] })])).toEqual(["exec_n"]);
  });

  it("excludes a sandboxed read-only root active the whole time, includes a Windows root", () => {
    const root = node({ executionId: "exec_root", workspaceMode: "read-only", startedAt: "2026-09-17T09:00:00.000Z", endedAt: null });
    expect(ambiguousNodes(child, [root])).toEqual([]);
    expect(ambiguousNodes(child, [{ ...root, writeIsolation: "none" }])).toEqual(["exec_root"]);
  });

  it("never names C itself, and returns ids sorted", () => {
    expect(ambiguousNodes(child, [child, node({ executionId: "exec_z" }), node({ executionId: "exec_a" })])).toEqual(["exec_a", "exec_z"]);
  });

  it("treats a node that never started as active from its creation — it cannot be proven idle", () => {
    // `startedAt: null` with no end: preparing/queued the whole time; the safe answer is "maybe".
    expect(ambiguousNodes(child, [node({ startedAt: null, endedAt: null })])).toEqual(["exec_n"]);
  });
});

/**
 * Oracle: spec "Producers (1)" — after settle, `paths` are the files whose status differs
 * from the baseline or whose content hash differs; a file dirty before the child and unchanged
 * by it is not counted; `commit` is the new HEAD when it moved.
 */
describe("diffBaseline", () => {
  const before: GitBaselineV1 = {
    version: 1,
    head: "aaa",
    dirty: [
      { path: "/ws/notes.md", status: " M", contentHash: "h-notes" },
      { path: "/ws/scratch.txt", status: "??", contentHash: "h-scratch" },
    ],
  };

  it("does not count a pre-dirty file the child left alone", () => {
    expect(diffBaseline(before, before, [])).toEqual({ paths: [], commit: null });
  });

  it("counts a pre-dirty file whose content changed, and a new dirty file", () => {
    const after: GitBaselineV1 = {
      ...before,
      dirty: [
        { path: "/ws/notes.md", status: " M", contentHash: "h-notes-2" },
        { path: "/ws/scratch.txt", status: "??", contentHash: "h-scratch" },
        { path: "/ws/src/new.ts", status: "??", contentHash: "h-new" },
      ],
    };
    expect(diffBaseline(before, after, [])).toEqual({ paths: ["/ws/notes.md", "/ws/src/new.ts"], commit: null });
  });

  it("counts a pre-dirty file that is no longer dirty, and a status change", () => {
    const after: GitBaselineV1 = { ...before, dirty: [{ path: "/ws/notes.md", status: "M ", contentHash: "h-notes" }] };
    expect(diffBaseline(before, after, [])).toEqual({ paths: ["/ws/notes.md", "/ws/scratch.txt"], commit: null });
  });

  it("reports the new HEAD and the files committed between the two heads", () => {
    const after: GitBaselineV1 = { version: 1, head: "bbb", dirty: [] };
    expect(diffBaseline(before, after, ["/ws/src/lib.ts", "/ws/notes.md"])).toEqual({
      paths: ["/ws/notes.md", "/ws/scratch.txt", "/ws/src/lib.ts"],
      commit: "bbb",
    });
  });
});

describe("outsideScope", () => {
  it("lists the changed paths that lie beside the scope, and nothing when unscoped", () => {
    expect(outsideScope(["/ws/src/a.ts", "/ws/docs/b.md", "/ws/src-old/c.ts"], ["/ws/src"], "/ws")).toEqual(["/ws/docs/b.md", "/ws/src-old/c.ts"]);
    expect(outsideScope(["/ws/src/a.ts", "/elsewhere/x"], null, "/ws")).toEqual(["/elsewhere/x"]);
    // An excluded subtree is outside the scope even though it sits inside a root (2b).
    expect(outsideScope(["/ws/src/a.ts", "/ws/src/parser/p.ts"], ["/ws/src"], "/ws", ["/ws/src/parser"])).toEqual(["/ws/src/parser/p.ts"]);
  });
});

/**
 * Oracle: spec "Contract" — `requiredEvidence` entries are `change` or `verify:<id>`.
 */
describe("parseRequiredEvidence", () => {
  it("normalizes, sorts and de-duplicates the accepted forms", () => {
    expect(parseRequiredEvidence([" verify:test", "change", "verify:test", "verify:lint"])).toEqual(["change", "verify:lint", "verify:test"]);
  });

  it("refuses anything else", () => {
    for (const value of ["", "verify:", "verify", "output", "Change", "verify:a b"]) {
      expect(() => parseRequiredEvidence([value])).toThrow(/requiredEvidence/);
    }
  });
});

/**
 * Oracle: spec "Evaluator" — a matching `observed|derived` item meets a requirement; an
 * `unknown` item (or `verify-skipped`) makes it unknown; nothing at all is missing; all met
 * ⇒ satisfied; any missing ⇒ unsatisfied; otherwise unknown. `self-reported` never
 * satisfies; `verify:<id>` needs `exitCode === 0`.
 */
describe("evaluateEvidence", () => {
  const change = (provenance: EvidenceItem["provenance"], paths: readonly string[] = ["/ws/a.ts"]): EvidenceItem => ({
    kind: "change", provenance, source: "git", paths, commit: null, outsideScope: [], outsideScopeVerified: true, ambiguousWith: [],
  } as EvidenceItem);
  const verify = (commandId: string, exitCode: number): EvidenceItem => ({
    kind: "verify", provenance: "observed", source: "alp-verifier", commandId, commandDigest: "d", exitCode, durationMs: 1, tail: "", ambiguousWith: [],
  });
  const skipped = (commandId: string, reason: "untrusted" | "not-configured" | "timeout"): EvidenceItem => ({
    kind: "verify-skipped", provenance: "unknown", source: "alp-verifier", commandId, reason,
  });
  const output: EvidenceItem = { kind: "output", provenance: "self-reported", source: "agent-output", digest: "x" };

  // GitHub #23: an empty requirement list is not "met", it is "never checked" — an execution
  // that did nothing and one that committed and pushed must not share a verdict.
  it("is unevaluated with nothing required, whatever the items say", () => {
    expect(evaluateEvidence([], [output])).toEqual({ evaluation: "unevaluated", missing: [] });
    expect(evaluateEvidence([], [change("observed")])).toEqual({ evaluation: "unevaluated", missing: [] });
    expect(evaluateEvidence([], [])).toEqual({ evaluation: "unevaluated", missing: [] });
  });

  it("meets `change` with an observed or derived change that names paths", () => {
    expect(evaluateEvidence(["change"], [change("observed")])).toEqual({ evaluation: "satisfied", missing: [] });
    expect(evaluateEvidence(["change"], [change("derived")])).toEqual({ evaluation: "satisfied", missing: [] });
  });

  it("is unknown when the only change is unknown, and unsatisfied when there is none", () => {
    expect(evaluateEvidence(["change"], [change("unknown", [])])).toEqual({ evaluation: "unknown", missing: [] });
    expect(evaluateEvidence(["change"], [output])).toEqual({ evaluation: "unsatisfied", missing: ["change"] });
    // An observed change of nothing is not evidence of a change.
    expect(evaluateEvidence(["change"], [change("observed", [])])).toEqual({ evaluation: "unsatisfied", missing: ["change"] });
  });

  it("meets `verify:<id>` only with that command's exit code 0", () => {
    expect(evaluateEvidence(["verify:test"], [verify("test", 0)])).toEqual({ evaluation: "satisfied", missing: [] });
    expect(evaluateEvidence(["verify:test"], [verify("test", 1)])).toEqual({ evaluation: "unsatisfied", missing: ["verify:test"] });
    expect(evaluateEvidence(["verify:test"], [verify("lint", 0)])).toEqual({ evaluation: "unsatisfied", missing: ["verify:test"] });
    expect(evaluateEvidence(["verify:test"], [skipped("test", "untrusted")])).toEqual({ evaluation: "unknown", missing: [] });
    expect(evaluateEvidence(["verify:test"], [skipped("test", "timeout")])).toEqual({ evaluation: "unknown", missing: [] });
  });

  it("lets a missing requirement decide over an unknown one", () => {
    expect(evaluateEvidence(["change", "verify:test"], [change("unknown", [])])).toEqual({ evaluation: "unsatisfied", missing: ["verify:test"] });
    expect(evaluateEvidence(["change", "verify:test"], [change("observed"), skipped("test", "untrusted")])).toEqual({ evaluation: "unknown", missing: [] });
  });
});

describe("evidenceDigest", () => {
  it("is independent of key order and sensitive to content", () => {
    const a: EvidenceItem = { kind: "output", provenance: "self-reported", source: "agent-output", digest: "x" };
    const b = { source: "agent-output", digest: "x", provenance: "self-reported", kind: "output" } as EvidenceItem;
    expect(evidenceDigest([a])).toBe(evidenceDigest([b]));
    expect(evidenceDigest([a])).toMatch(/^[0-9a-f]{64}$/);
    expect(evidenceDigest([{ ...a, digest: "y" }])).not.toBe(evidenceDigest([a]));
  });
});
