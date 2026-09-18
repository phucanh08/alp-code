import { describe, expect, it } from "vitest";
import { RUNTIME_IDS } from "../../src/agents/types";
import type { ExecutionPolicy } from "../../src/execution/types";
import {
  ENFORCEMENT_FIELDS,
  ENFORCEMENT_LEVELS,
  capabilitiesFor,
  describeEnforcement,
  readEnforcement,
  versionMatchesMeasured,
} from "../../src/runtime/capabilities";

const PLATFORMS = ["darwin", "linux", "win32"] as const satisfies readonly NodeJS.Platform[];

/** Only the fields `describeEnforcement` reads; the rest of a policy is irrelevant to it. */
const POLICY_SHAPE = {
  allowedTools: ["Read"],
  workspaceAccess: "granted",
} as unknown as ExecutionPolicy;

/**
 * Oracle: the measurements of 2026-09-10 recorded at the head of `permission-rules.ts` and
 * in `docs/delegation.md`, re-run 2026-09-12 with `codex sandbox` (write outside the
 * writable roots → `Operation not permitted`; `curl` → could not resolve host), plus the
 * Claude adapter's own statement that no sandbox is activated on Windows.
 */
describe("capabilitiesFor — the measured table", () => {
  it("has a complete row for every (runtime, platform), typed and dated", () => {
    for (const runtime of RUNTIME_IDS) {
      for (const platform of PLATFORMS) {
        const row = capabilitiesFor(runtime, platform);
        expect(row.version).toBe(1);
        expect(row.runtime).toBe(runtime);
        expect(row.measuredOn.platform).toBe(platform);
        expect(row.measuredOn.runtimeVersion).toMatch(/^\d+\.\d+/);
        expect(Number.isNaN(Date.parse(row.measuredOn.measuredAt))).toBe(false);
        for (const field of ENFORCEMENT_FIELDS) expect(ENFORCEMENT_LEVELS).toContain(row[field]);
        expect(Object.isFrozen(row)).toBe(true);
      }
    }
  });

  it("states what Codex's sandbox does and does not enforce on darwin/linux", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const codex = capabilitiesFor("codex", platform);
      // The shell is built in: a role holding no `Bash` still ran `/bin/zsh -lc`.
      expect(codex.toolGrant).toBe("declared-only");
      // `codex sandbox -c sandbox_mode='"read-only"' -- cat <outside>` printed the file.
      expect(codex.readIsolation).toBe("none");
      expect(codex.writeIsolation).toBe("enforced");
      expect(codex.networkEgress).toBe("enforced");
      // `[[rules]] prefix = ["herdr"] allow = false` is honoured by the runtime.
      expect(codex.nativeDelegationDeny).toBe("enforced");
    }
  });

  it("states what Claude's ACL and sandbox enforce on darwin/linux", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const claude = capabilitiesFor("claude", platform);
      expect(claude.toolGrant).toBe("enforced");
      expect(claude.readIsolation).toBe("enforced");
      expect(claude.writeIsolation).toBe("enforced");
      // No sandbox rule for egress: only the tool grant stands between the role and the net.
      expect(claude.networkEgress).toBe("declared-only");
      expect(claude.nativeDelegationDeny).toBe("enforced");
    }
  });

  it("does not promise a sandbox on Windows, where Claude activates none", () => {
    const claude = capabilitiesFor("claude", "win32");
    expect(claude.toolGrant).toBe("enforced");
    expect(claude.readIsolation).toBe("declared-only");
    expect(claude.writeIsolation).toBe("none");
    expect(claude.writeScope).toBe("declared-only");
    expect(claude.nativeDelegationDeny).toBe("enforced");
  });

  /**
   * Fail-closed: a cell nobody measured is `none`, never a guess copied from the platform
   * next door. Codex on Windows is that cell.
   */
  it("reports `none` for every cell that has not been measured", () => {
    const codexWindows = capabilitiesFor("codex", "win32");
    expect(codexWindows.writeIsolation).toBe("none");
    expect(codexWindows.writeScope).toBe("none");
    expect(codexWindows.networkEgress).toBe("none");
  });

  /**
   * Measured 2026-09-12 (`research/claude-sandbox-precedence.md`, Claude Code 2.1.269):
   * `denyWrite` beats `allowWrite`, so a scope narrower than the workspace is expressed by
   * denying its enumerated siblings — refused for what existed at launch, not for an entry
   * created beside the scope afterwards. That is `partial`, not `enforced` and not `none`.
   */
  it("reports `partial` for Claude's write scope on darwin/linux", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(capabilitiesFor("claude", platform).writeScope).toBe("partial");
    }
  });

  it("refuses a platform it has no row for instead of inventing one", () => {
    expect(() => capabilitiesFor("codex", "freebsd")).toThrowError(/no enforcement table.*freebsd/);
  });
});

describe("describeEnforcement — notes generated from the table", () => {
  it("prints one line per field, prefixed with the runtime it describes", () => {
    const lines = describeEnforcement(capabilitiesFor("codex", "darwin"), POLICY_SHAPE);
    expect(lines).toHaveLength(ENFORCEMENT_FIELDS.length);
    for (const line of lines) expect(line.startsWith("codex: ")).toBe(true);
    for (const field of ENFORCEMENT_FIELDS) expect(lines.some((line) => line.includes(field))).toBe(true);
  });

  it("names the level of each cell so a principal can read the table without the code", () => {
    const codex = describeEnforcement(capabilitiesFor("codex", "darwin"), POLICY_SHAPE).join("\n");
    expect(codex).toMatch(/toolGrant.*declared-only/);
    expect(codex).toMatch(/readIsolation.*none/);
    expect(codex).toMatch(/writeIsolation.*enforced/);
    const claude = describeEnforcement(capabilitiesFor("claude", "win32"), POLICY_SHAPE).join("\n");
    expect(claude).toMatch(/writeIsolation.*none/);
  });

  /**
   * The note has to describe *this* policy, not a generic warning: telling a role that holds
   * `Bash` that "a command can still run" says nothing, and a reader who sees the same
   * paragraph on every agent stops reading it.
   */
  it("drops the `Bash` caveat for a role that was granted it", () => {
    const codex = capabilitiesFor("codex", "darwin");
    const withBash = describeEnforcement(codex, { ...POLICY_SHAPE, allowedTools: ["Read", "Bash"] } as ExecutionPolicy);
    const withoutBash = describeEnforcement(codex, { ...POLICY_SHAPE, allowedTools: ["Read"] } as ExecutionPolicy);

    expect(withBash.join("\n")).not.toContain("holds no `Bash`");
    expect(withoutBash.join("\n")).toContain("holds no `Bash`");
    expect(withBash.join("\n")).toContain("cannot be withheld");
  });

  it("says the boundary is instruction-level for a memory-only role on Codex", () => {
    const codex = capabilitiesFor("codex", "darwin");
    expect(describeEnforcement(codex, { ...POLICY_SHAPE, workspaceAccess: "none" } as ExecutionPolicy).join("\n"))
      .toContain("the memory-only boundary is instruction-level here");
    expect(describeEnforcement(codex, POLICY_SHAPE).join("\n"))
      .toContain("`workspace.readRoots` is instruction-level here");
  });

  it("does not print a Codex caveat under a Claude row", () => {
    const claude = describeEnforcement(capabilitiesFor("claude", "darwin"), POLICY_SHAPE).join("\n");
    expect(claude).not.toContain("cannot be withheld");
    expect(claude).not.toContain("instruction-level here");
  });
});

/**
 * Cutover: a `policy.json` written before this field existed has no `enforcement`. The
 * reader says so (`null`) rather than inventing a row; a present-but-foreign shape is an
 * error, because a record that half-parses is worse than one that refuses.
 */
describe("readEnforcement — reading a snapshot from disk", () => {
  it("returns null for a snapshot that predates the field", () => {
    expect(readEnforcement({ role: "search", policyHash: "abc" })).toBeNull();
    expect(readEnforcement({ enforcement: undefined })).toBeNull();
  });

  it("returns the row when it is a v1 record", () => {
    const row = capabilitiesFor("claude", "darwin");
    expect(readEnforcement({ enforcement: JSON.parse(JSON.stringify(row)) })).toEqual(row);
  });

  it("refuses a record of another version or shape", () => {
    expect(() => readEnforcement({ enforcement: { version: 2 } })).toThrowError(/enforcement/);
    expect(() => readEnforcement({ enforcement: "enforced" })).toThrowError(/enforcement/);
    expect(() => readEnforcement({ enforcement: { ...capabilitiesFor("codex", "linux"), writeIsolation: "maybe" } }))
      .toThrowError(/writeIsolation/);
  });
});

/**
 * The table is pinned to the major.minor it was measured on. A launch on `2.1.269` matches
 * a table measured on `2.1`; `2.2.0` does not; `unknown` never does.
 */
describe("versionMatchesMeasured", () => {
  it("matches on the measured prefix at a version boundary", () => {
    expect(versionMatchesMeasured("2.1", "2.1.269")).toBe(true);
    expect(versionMatchesMeasured("0.154", "0.154.0")).toBe(true);
    expect(versionMatchesMeasured("2.1", "2.10.0")).toBe(false);
    expect(versionMatchesMeasured("2.1", "2.2.0")).toBe(false);
    expect(versionMatchesMeasured("2.1", "unknown")).toBe(false);
  });
});
