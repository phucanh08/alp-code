import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { APPROVAL_RULE_IDS, APPROVAL_SCOPES, type ApprovalRuleId, type ApprovalScope, type PolicyDecision } from "../policy/types";

/**
 * A "yes" the principal gave, as the execution carries it.
 *
 * Lives inside `ExecutionPolicy.approvals` and therefore inside `policyHash`: an execution
 * that was allowed to widen its workspace because a person said so is a different identity
 * from one that was not asked, and the record has to say which one ran. `decidedBy` is
 * always the principal in phase 1 — no role can answer for another.
 */
export interface ApprovalRecordV1 {
  readonly version: 1;
  readonly rule: ApprovalRuleId;
  /** The canonical path the question was about — what a session-scoped "yes" is keyed by. */
  readonly subject: string;
  readonly scope: ApprovalScope;
  readonly decidedBy: "principal";
  readonly decidedAt: string;
}

/**
 * The approvals a root execution has collected for its session, at
 * `<root execution>/context/approvals.json`. A "yes" with `scope: "session"` goes here and
 * answers the same question — same rule, same subject — for every launch under that root
 * without asking again. A "no" is never stored: the principal may change their mind.
 */
export interface SessionApprovals {
  list(): Promise<readonly ApprovalRecordV1[]>;
  record(approval: ApprovalRecordV1): Promise<void>;
}

/** The same question, asked again: same rule and same subject. Scope is not part of the key. */
export function matchesDecision(record: ApprovalRecordV1, decision: Extract<PolicyDecision, { kind: "require_approval" }>): boolean {
  return record.rule === decision.rule && record.subject === decision.subject;
}

export class InMemorySessionApprovals implements SessionApprovals {
  private readonly records: ApprovalRecordV1[] = [];

  async list(): Promise<readonly ApprovalRecordV1[]> {
    return Object.freeze([...this.records]);
  }

  async record(approval: ApprovalRecordV1): Promise<void> {
    this.records.push(approval);
  }
}

const APPROVALS_FILE_MODE = 0o600;

/**
 * `context/` outlives `runtime/` cleanup, which is the point: the answers a principal gave
 * are part of the record of the session, not scratch. The file is a plain JSON array; a
 * missing file is an empty session, a malformed one is an error rather than an empty one.
 */
export class FileSessionApprovals implements SessionApprovals {
  constructor(private readonly file: string) {}

  async list(): Promise<readonly ApprovalRecordV1[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`session approvals at ${this.file} are not a list`);
    return Object.freeze(parsed.map((entry, index) => parseApprovalRecord(entry, `session approvals at ${this.file}, entry ${index}`)));
  }

  async record(approval: ApprovalRecordV1): Promise<void> {
    const records = [...(await this.list()), approval];
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(this.file, `${JSON.stringify(records, null, 2)}\n`, { encoding: "utf8", mode: APPROVALS_FILE_MODE });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseApprovalRecord(value: unknown, where: string): ApprovalRecordV1 {
  if (!isRecord(value) || value.version !== 1) throw new Error(`${where}: not a version 1 approval record`);
  if (typeof value.rule !== "string" || !(APPROVAL_RULE_IDS as readonly string[]).includes(value.rule)) {
    throw new Error(`${where}: unknown approval rule`);
  }
  if (typeof value.subject !== "string" || value.subject === "") throw new Error(`${where}: approval has no subject`);
  if (typeof value.scope !== "string" || !(APPROVAL_SCOPES as readonly string[]).includes(value.scope)) {
    throw new Error(`${where}: unknown approval scope`);
  }
  if (value.decidedBy !== "principal") throw new Error(`${where}: approval was not decided by the principal`);
  if (typeof value.decidedAt !== "string") throw new Error(`${where}: approval has no decidedAt`);
  return Object.freeze({
    version: 1,
    rule: value.rule as ApprovalRuleId,
    subject: value.subject,
    scope: value.scope as ApprovalScope,
    decidedBy: "principal",
    decidedAt: value.decidedAt,
  });
}

/**
 * The `approvals` row out of a `policy.json` read from disk. `[]` when the snapshot predates
 * the field — an execution nobody asked anything about; an error when it carries a record of
 * another version or shape. A cutover reader: the bridge and the CLI read through it so
 * old snapshots keep verifying and new ones cannot half-parse.
 */
export function readApprovals(snapshot: Readonly<Record<string, unknown>>): readonly ApprovalRecordV1[] {
  const value = snapshot.approvals;
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error("policy `approvals` is not a list");
  return Object.freeze(value.map((entry, index) => parseApprovalRecord(entry, `policy \`approvals[${index}]\``)));
}
