import { RUNTIME_IDS, type RuntimeId } from "../agents/types";
import type { ExecutionPolicy } from "../execution/types";

/**
 * What each runtime *actually refuses*, per platform, as measured — not as the ACL declares.
 *
 * The Authority table a role reads is one promise written twice: Claude refuses an ungranted
 * tool at call time, Codex cannot withhold its shell and reads any path. Before this table
 * the difference lived in a hand-written paragraph next to the ACL code; a paragraph has no
 * `measuredOn`, cannot be snapshotted into `policy.json`, and cannot be compared against a
 * probe. Every row here is a claim with a date and a runtime version on it, and P3's
 * evidence and tier 2's drift probe read the claim rather than the prose.
 *
 * Levels:
 *  - `enforced`      — the runtime refuses the operation itself (sandbox, ACL rule).
 *  - `partial`       — the runtime refuses what ALP could name at launch, and nothing more:
 *                      the boundary is enumerated, not a rule, so what appears after the
 *                      enumeration (a new entry beside a write scope) is not refused.
 *  - `declared-only` — ALP states the boundary (prompt, config) but nothing refuses it.
 *  - `none`          — not enforced, **or not measured**. A cell nobody has measured is
 *                      `none`, never a guess copied from the platform next door.
 */
export const ENFORCEMENT_LEVELS = ["enforced", "partial", "declared-only", "none"] as const;
export type EnforcementLevel = (typeof ENFORCEMENT_LEVELS)[number];

export const ENFORCEMENT_FIELDS = [
  "toolGrant",
  "readIsolation",
  "writeIsolation",
  "writeScope",
  "networkEgress",
  "nativeDelegationDeny",
] as const;
export type EnforcementField = (typeof ENFORCEMENT_FIELDS)[number];

export interface RuntimeEnforcementCapabilitiesV1 {
  readonly version: 1;
  readonly runtime: RuntimeId;
  readonly measuredOn: {
    readonly platform: NodeJS.Platform;
    /** The `major.minor` the row was measured on — see `versionMatchesMeasured`. */
    readonly runtimeVersion: string;
    readonly measuredAt: string;
  };
  /** Whether a tool outside `allowedTools` is refused when the model calls it. */
  readonly toolGrant: EnforcementLevel;
  /** Whether a read outside the read roots (workspace, own memory) is refused. */
  readonly readIsolation: EnforcementLevel;
  /** Whether a write outside the writable roots is refused. */
  readonly writeIsolation: EnforcementLevel;
  /** Whether writes are confined to the *declared* write roots, narrower than the workspace. */
  readonly writeScope: EnforcementLevel;
  /** Whether a connection the grant does not cover is refused. */
  readonly networkEgress: EnforcementLevel;
  /** Whether the runtime's own agent tool and the raw runtime commands are refused. */
  readonly nativeDelegationDeny: EnforcementLevel;
}

type Cells = Readonly<Record<EnforcementField, EnforcementLevel>>;

/**
 * Pinned to `major.minor`, the same granularity the history bridges pin their transcript
 * format to: a patch release does not move the sandbox, and a table that flagged every
 * patch as unmeasured would be ignored by the second week.
 */
const CLAUDE_MEASURED = { runtimeVersion: "2.1", measuredAt: "2026-09-18" } as const;
const CODEX_MEASURED = { runtimeVersion: "0.154", measuredAt: "2026-09-18" } as const;

/**
 * Measured 2026-09-10 (`link-auditor` on Codex ran `/bin/zsh -lc` holding no `Bash`;
 * `codex sandbox -c sandbox_mode='"read-only"' -- cat <outside>` printed the file) and
 * re-run 2026-09-12 with `codex sandbox` on `workspace-write`: a write outside the writable
 * roots → `Operation not permitted`, `curl` → could not resolve host. `[[rules]]` with
 * `allow = false` is honoured by the runtime.
 *
 * Re-measured 2026-09-18 on the form the launch actually uses since the relay (`-c
 * default_permissions` profile on argv; `plans/260918-0700-execution-relay/research/`):
 * a path is writable only when listed, an entry created beside the scope is refused, `.git`
 * under a write root stays read-only, and with no `network` section `curl` still cannot
 * resolve a host. `writeScope` is the same seatbelt as `writeIsolation`: the profile's
 * `"write"` entries *are* the declared scope. Until then the scope had only been written to
 * a config file Codex never read — the cell was measured on the mechanism, not on the launch.
 */
const CODEX_POSIX: Cells = {
  toolGrant: "declared-only",
  readIsolation: "none",
  writeIsolation: "enforced",
  writeScope: "enforced",
  networkEgress: "enforced",
  nativeDelegationDeny: "enforced",
};

/** Nothing about the Codex sandbox has been measured on Windows: every sandbox cell is `none`. */
const CODEX_WIN32: Cells = {
  toolGrant: "declared-only",
  readIsolation: "none",
  writeIsolation: "none",
  writeScope: "none",
  networkEgress: "none",
  nativeDelegationDeny: "enforced",
};

/**
 * The permission rules are refused at call time (tool grant, `Skill(name)`, read roots,
 * `deny Task/Agent`); the darwin/linux sandbox refuses writes outside the workspace. No
 * sandbox rule covers egress — only the tool grant stands between the role and the net.
 * `writeScope` is `partial` (measured 2026-09-12, `research/claude-sandbox-precedence.md`):
 * `denyWrite` beats `allowWrite`, so a scope is expressed by denying its enumerated siblings
 * — existing paths beside the scope are refused, a path created there afterwards is not.
 */
const CLAUDE_POSIX: Cells = {
  toolGrant: "enforced",
  readIsolation: "enforced",
  writeIsolation: "enforced",
  writeScope: "partial",
  networkEgress: "declared-only",
  nativeDelegationDeny: "enforced",
};

/**
 * Claude activates no sandbox on Windows (see `sandboxAvailable` in the Claude adapter): the
 * ACL still refuses tools and `Read`/`Edit` outside the roots, but a shell redirect is not a
 * tool call, so read isolation is what the prompt says and write isolation is nothing.
 */
const CLAUDE_WIN32: Cells = {
  toolGrant: "enforced",
  readIsolation: "declared-only",
  writeIsolation: "none",
  writeScope: "declared-only",
  networkEgress: "declared-only",
  nativeDelegationDeny: "enforced",
};

const TABLE: Readonly<Record<RuntimeId, Partial<Record<NodeJS.Platform, { cells: Cells; measured: typeof CLAUDE_MEASURED | typeof CODEX_MEASURED }>>>> = {
  codex: {
    darwin: { cells: CODEX_POSIX, measured: CODEX_MEASURED },
    linux: { cells: CODEX_POSIX, measured: CODEX_MEASURED },
    win32: { cells: CODEX_WIN32, measured: CODEX_MEASURED },
  },
  claude: {
    darwin: { cells: CLAUDE_POSIX, measured: CLAUDE_MEASURED },
    linux: { cells: CLAUDE_POSIX, measured: CLAUDE_MEASURED },
    win32: { cells: CLAUDE_WIN32, measured: CLAUDE_MEASURED },
  },
};

/** The table row for a runtime on a platform. Throws for a platform no row was written for. */
export function capabilitiesFor(runtime: RuntimeId, platform: NodeJS.Platform): RuntimeEnforcementCapabilitiesV1 {
  const row = TABLE[runtime]?.[platform];
  if (row === undefined) throw new Error(`no enforcement table for \`${runtime}\` on \`${platform}\``);
  return Object.freeze({
    version: 1,
    runtime,
    measuredOn: Object.freeze({ platform, ...row.measured }),
    ...row.cells,
  });
}

/**
 * `2.1.269` matches a table measured on `2.1`; `2.10.0` and `2.2.0` do not; `unknown` never
 * does. A mismatch never blocks a launch — it lowers what the record may claim.
 */
export function versionMatchesMeasured(measured: string, actual: string): boolean {
  return actual === measured || actual.startsWith(`${measured}.`);
}

const LEVEL_PHRASES: Readonly<Record<EnforcementLevel, string>> = {
  enforced: "refused by the runtime",
  partial: "refused by the runtime for what existed beside the scope at launch; an entry created there afterwards is not",
  "declared-only": "stated to the role, not refused by the runtime",
  none: "not enforced (or not measured)",
};

/**
 * Notes for a principal, one per field, generated from the table so they cannot drift from
 * it. Each line is phrased for *this* policy: a caveat about running a command anyway says
 * nothing to a role that holds `Bash`, and a reader who sees the same paragraph on every
 * agent stops reading it.
 */
export function describeEnforcement(
  capabilities: RuntimeEnforcementCapabilitiesV1,
  policy: Pick<ExecutionPolicy, "allowedTools" | "workspaceAccess">,
): readonly string[] {
  const { runtime } = capabilities;
  const holdsBash = policy.allowedTools.includes("Bash");
  const readsWorkspace = policy.workspaceAccess === "granted";
  const explain = (field: EnforcementField): string => {
    const level = capabilities[field];
    if (runtime === "codex") {
      if (field === "toolGrant") {
        return `the shell is built in and cannot be withheld${holdsBash ? "" : " — this role holds no `Bash`, and a command can still run"}`;
      }
      if (field === "readIsolation") {
        return `the read-only sandbox permits reading any path${readsWorkspace ? ", so `workspace.readRoots` is instruction-level here" : ", so the memory-only boundary is instruction-level here"}`;
      }
    }
    if (runtime === "claude" && field === "toolGrant" && level === "enforced") {
      return "the tool grant, the skill names and the read roots are ACL rules the runtime refuses at call time";
    }
    return `${FIELD_SUBJECT[field]} — ${LEVEL_PHRASES[level]}`;
  };
  return Object.freeze(ENFORCEMENT_FIELDS.map((field) => `${runtime}: ${field} ${capabilities[field]} — ${explain(field)}`));
}

const FIELD_SUBJECT: Readonly<Record<EnforcementField, string>> = {
  toolGrant: "a tool outside the grant",
  readIsolation: "a read outside the read roots",
  writeIsolation: "a write outside the writable roots",
  writeScope: "a write outside the declared write roots",
  networkEgress: "a connection the grant does not cover",
  nativeDelegationDeny: "the runtime's own agent tool and the raw runtime commands",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The `enforcement` row out of a `policy.json` read from disk. `null` when the snapshot
 * predates the field; an error when it carries one of another version or shape — a record
 * that half-parses is worse than one that refuses.
 */
export function readEnforcement(snapshot: Readonly<Record<string, unknown>>): RuntimeEnforcementCapabilitiesV1 | null {
  const value = snapshot.enforcement;
  if (value === undefined) return null;
  if (!isRecord(value) || value.version !== 1) throw new Error("policy `enforcement` is not a version 1 record");
  const runtime = value.runtime;
  if (typeof runtime !== "string" || !(RUNTIME_IDS as readonly string[]).includes(runtime)) {
    throw new Error("policy `enforcement` names no known runtime");
  }
  const measuredOn = value.measuredOn;
  if (
    !isRecord(measuredOn)
    || typeof measuredOn.platform !== "string"
    || typeof measuredOn.runtimeVersion !== "string"
    || typeof measuredOn.measuredAt !== "string"
  ) {
    throw new Error("policy `enforcement.measuredOn` is incomplete");
  }
  const cells = {} as Record<EnforcementField, EnforcementLevel>;
  for (const field of ENFORCEMENT_FIELDS) {
    const level = value[field];
    if (typeof level !== "string" || !(ENFORCEMENT_LEVELS as readonly string[]).includes(level)) {
      throw new Error(`policy \`enforcement.${field}\` is not an enforcement level`);
    }
    cells[field] = level as EnforcementLevel;
  }
  return Object.freeze({
    version: 1,
    runtime: runtime as RuntimeId,
    measuredOn: Object.freeze({
      platform: measuredOn.platform as NodeJS.Platform,
      runtimeVersion: measuredOn.runtimeVersion,
      measuredAt: measuredOn.measuredAt,
    }),
    ...cells,
  });
}
