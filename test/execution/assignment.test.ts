import { describe, expect, it } from "vitest";
import { ownsPath, renderAssignment, sharedRegion, type AssignmentScope } from "../../src/execution/assignment";

const scope = (writeScope: readonly string[] | null, excludeScope: readonly string[] | null = null, workspace = "/ws"): AssignmentScope =>
  ({ workspace, writeScope, excludeScope });

/**
 * Oracle: master plan 2b "Assignment có biên" — two live `worker`s cannot own the same path;
 * an exclusion is the complement of a scope, so two scopes that meet only where one of them
 * excluded the meeting point do not overlap; the child is told its objective, owned paths,
 * excluded paths and verification as separate fields, before the task.
 */
describe("assignment — sharedRegion", () => {
  it("names the deeper root when one owned root contains the other", () => {
    expect(sharedRegion(scope(["/ws/src"]), scope(["/ws/src/parser"]))).toBe("/ws/src/parser");
    expect(sharedRegion(scope(["/ws/src/parser"]), scope(["/ws/src"]))).toBe("/ws/src/parser");
    expect(sharedRegion(scope(["/ws/src"]), scope(["/ws/src"]))).toBe("/ws/src");
    // Unscoped is the whole workspace.
    expect(sharedRegion(scope(null), scope(["/ws/docs"]))).toBe("/ws/docs");
  });

  it("finds no region between disjoint roots or disjoint workspaces", () => {
    expect(sharedRegion(scope(["/ws/src"]), scope(["/ws/docs"]))).toBeNull();
    expect(sharedRegion(scope(["/ws/src"]), scope(["/ws/src-extra"]))).toBeNull();
    expect(sharedRegion(scope(null), scope(null, null, "/other"))).toBeNull();
  });

  it("lets an exclusion on either side carve the meeting point out", () => {
    // `src` minus `src/parser` beside `src/parser`: no conflict.
    expect(sharedRegion(scope(["/ws/src"], ["/ws/src/parser"]), scope(["/ws/src/parser"]))).toBeNull();
    expect(sharedRegion(scope(["/ws/src/parser"]), scope(["/ws/src"], ["/ws/src/parser"]))).toBeNull();
    // An exclusion wider than the meeting point still covers it.
    expect(sharedRegion(scope(["/ws/src"], ["/ws/src/parser"]), scope(["/ws/src/parser/ast"]))).toBeNull();
    // An exclusion narrower than the meeting point leaves the rest shared.
    expect(sharedRegion(scope(["/ws/src"], ["/ws/src/parser/ast"]), scope(["/ws/src/parser"]))).toBe("/ws/src/parser");
    // Excluding something else entirely changes nothing.
    expect(sharedRegion(scope(["/ws/src"], ["/ws/src/lexer"]), scope(["/ws/src/parser"]))).toBe("/ws/src/parser");
  });
});

describe("assignment — ownsPath", () => {
  it("owns inside a root and not inside an exclusion", () => {
    const owned = scope(["/ws/src"], ["/ws/src/parser"]);
    expect(ownsPath(owned, "/ws/src/lexer/lex.ts")).toBe(true);
    expect(ownsPath(owned, "/ws/src/parser/parse.ts")).toBe(false);
    expect(ownsPath(owned, "/ws/docs/guide.md")).toBe(false);
    expect(ownsPath(scope(null), "/ws/anything")).toBe(true);
  });
});

describe("assignment — renderAssignment", () => {
  it("returns the task untouched when there is nothing but the task", () => {
    expect(renderAssignment({ task: "Fix the parser", objective: null, verification: null, scope: null })).toBe("Fix the parser");
  });

  it("puts objective, owned, excluded and verification as separate lines before the task", () => {
    const rendered = renderAssignment({
      task: "Fix the parser",
      objective: "Parser accepts trailing commas",
      verification: "npx vitest run test/parser",
      scope: scope(["/ws/src"], ["/ws/src/lexer"]),
    });
    expect(rendered.split("\n")).toEqual([
      "Objective: Parser accepts trailing commas",
      "Owned paths (you may write): `/ws/src`",
      "Excluded paths (you may not write, another execution owns them): `/ws/src/lexer`",
      "Verification (how done is checked): npx vitest run test/parser",
      "",
      "Fix the parser",
    ]);
  });

  it("spells out the whole workspace and no exclusion rather than leaving the lines out", () => {
    const rendered = renderAssignment({ task: "Fix", objective: "x", verification: null, scope: scope(null) });
    expect(rendered).toContain("Owned paths (you may write): the whole workspace `/ws`");
    expect(rendered).toContain("Excluded paths (you may not write, another execution owns them): none");
    expect(rendered).not.toContain("Verification");
  });
});
