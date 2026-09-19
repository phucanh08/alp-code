import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { RuntimeId } from "../agents/types";
import { RUNTIME_IDS } from "../agents/types";
import { atomicRuntimeFile } from "../runtime/adapter-files";
import { readEnforcement, versionMatchesMeasured, type EnforcementLevel, type RuntimeEnforcementCapabilitiesV1 } from "../runtime/capabilities";
import { readLaunchReceipt } from "../runtime/launch-provenance";
import { unsupportedHistoryBridge, type HistoryBridgeRegistry } from "../thread/history-bridge";
import { sanitizeText } from "../thread/history-redact";
import type { CollectedEntry, HistoryCompleteness, HistoryDelta, RuntimeHistoryCursor, ThreadExecutionBoundary, ThreadToolCallRef } from "../thread/history-types";
import type { ThreadExecutionOutcome } from "../thread/types";
import { readExcludeScope, readWriteScope } from "./execution-policy";
import {
  accumulateUsage,
  countersOf,
  evaluateBudget,
  readExecutionUsage,
  writeExecutionUsage,
  type BudgetStatus,
  type ExecutionBudget,
  type UsageCounters,
} from "./usage";
import { ownsPath, sharedRegion, type AssignmentScope } from "./assignment";
import { executionArtifactPaths } from "./execution-store";
import type { ExecutionGraphService } from "./graph/execution-graph-service";
import { findNode, isTerminalNodeStatus, type ExecutionNode } from "./graph/types";

/**
 * Evidence — what ALP can *show* about a finished execution, kept apart from what the agent
 * *said* (`state.json.output`). Each item names where it came from and how far it can be
 * trusted:
 *
 * - `observed`: ALP saw it itself and nothing else could have produced it;
 * - `derived`: ALP saw it, but another execution could have contributed, or the runtime was
 *   not the one whose enforcement was measured;
 * - `self-reported`: the agent said so;
 * - `unknown`: the producer could not answer (no git, no transcript, untrusted verify).
 *
 * The file is `<execution>/evidence.json`, beside `policy.json` and under the same protected
 * root: never in the workspace the child could write, never in the Thread.
 */
export type Provenance = "observed" | "derived" | "self-reported" | "unknown";
export type EvidenceSource = "git" | "history-bridge" | "alp-verifier" | "agent-output" | "runtime-event";
/**
 * `unevaluated` is the empty case: the request declared no `requiredEvidence`, so nothing was
 * checked. It is deliberately not `satisfied` — GitHub #23 found a coordinator reading
 * `satisfied` off an execution that had done nothing, because "no requirement is missing"
 * and "the requirements are met" were the same word.
 */
export type EvidenceEvaluation = "unevaluated" | "satisfied" | "unsatisfied" | "unknown";

export interface EvidenceToolCallItem {
  readonly kind: "tool-call";
  readonly provenance: Provenance;
  readonly source: "history-bridge";
  readonly ref: Omit<ThreadToolCallRef, "version" | "executionId">;
}

export interface EvidenceChangeItem {
  readonly kind: "change";
  readonly provenance: Provenance;
  readonly source: "git" | "history-bridge";
  readonly paths: readonly string[];
  readonly commit: string | null;
  /** The changed paths that lie beside the declared scope (or outside the workspace when unscoped). */
  readonly outsideScope: readonly string[];
  /** True only when the runtime enforces the scope, so an empty `outsideScope` means "refused", not "not seen". */
  readonly outsideScopeVerified: boolean;
  /** Other executions that could have written the same files at the same time. */
  readonly ambiguousWith: readonly string[];
}

export interface EvidenceVerifyItem {
  readonly kind: "verify";
  readonly provenance: Provenance;
  readonly source: "alp-verifier";
  readonly commandId: string;
  readonly commandDigest: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly tail: string;
  readonly ambiguousWith: readonly string[];
}

export type VerifySkipReason = "untrusted" | "not-configured" | "timeout";

export interface EvidenceVerifySkippedItem {
  readonly kind: "verify-skipped";
  readonly provenance: "unknown";
  readonly source: "alp-verifier";
  readonly commandId: string;
  readonly reason: VerifySkipReason;
}

export interface EvidenceOutputItem {
  readonly kind: "output";
  readonly provenance: "self-reported";
  readonly source: "agent-output";
  readonly digest: string;
}

export interface EvidenceBoundaryItem {
  readonly kind: "boundary";
  readonly provenance: Provenance;
  readonly source: "runtime-event";
  readonly ref: Omit<ThreadExecutionBoundary, "version" | "executionId">;
}

/**
 * What the execution cost, as the bridge counted it, next to the budget the request declared
 * and how the two compare. Observe-only: `exceeded` is something the parent *sees*, never
 * something that changes the child's outcome or the evaluation of its requirements. Present
 * only when the bridge had numbers; a missing item means "not measured".
 */
export interface EvidenceUsageItem {
  readonly kind: "usage";
  readonly provenance: Provenance;
  readonly source: "history-bridge";
  readonly usage: UsageCounters;
  readonly budget: ExecutionBudget | null;
  readonly status: BudgetStatus;
}

export type EvidenceItem =
  | EvidenceToolCallItem
  | EvidenceChangeItem
  | EvidenceVerifyItem
  | EvidenceVerifySkippedItem
  | EvidenceOutputItem
  | EvidenceBoundaryItem
  | EvidenceUsageItem;

export interface ExecutionEvidenceV1 {
  readonly version: 1;
  readonly executionId: string;
  readonly requestId: string | null;
  readonly collectedAt: string;
  readonly completeness: HistoryCompleteness;
  readonly items: readonly EvidenceItem[];
  readonly digest: string;
}

/** `git status` at one moment, captured by `materialize()` and again at settle. */
export interface GitBaselineV1 {
  readonly version: 1;
  readonly head: string | null;
  readonly dirty: readonly { readonly path: string; readonly status: string; readonly contentHash: string | null }[];
}

/** What the overlap rule needs to know about any node — target or other. */
export interface OverlapNode {
  readonly executionId: string;
  readonly workspace: string;
  readonly workspaceMode: "read-only" | "workspace-write";
  readonly writeScope: readonly string[] | null;
  /** Carved out of the scope (master plan 2b); absent on records from before exclusions. */
  readonly excludeScope?: readonly string[] | null;
  readonly writeIsolation: EnforcementLevel | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

export interface VerifyCommand {
  readonly id: string;
  readonly run: string;
  readonly timeoutMs: number;
  readonly cwd: string;
}

export const EVIDENCE_FILE_NAME = "evidence.json";
export const BASELINE_FILE_NAME = "baseline.json";
export const VERIFY_TAIL_MAX_BYTES = 4 * 1024;

export function evidenceFile(executionsRoot: string, executionId: string): string {
  return join(executionsRoot, executionId, EVIDENCE_FILE_NAME);
}

export function baselineFile(contextDirectory: string): string {
  return join(contextDirectory, BASELINE_FILE_NAME);
}

export type EvidenceErrorCode = "EXECUTION_NOT_FOUND" | "EXECUTION_NOT_TERMINAL" | "POLICY_UNREADABLE" | "EVIDENCE_CORRUPT";

export class EvidenceError extends Error {
  constructor(readonly code: EvidenceErrorCode, message: string) {
    super(message);
    this.name = "EvidenceError";
  }
}

// ---------------------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------------------

function within(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry !== undefined) sorted[key] = sortKeys(entry);
  }
  return sorted;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Git may claim `observed` only when nobody else could have written and the sandbox refuses writes elsewhere. */
export function gitProvenance(input: { readonly baseline: boolean; readonly ambiguousWith: readonly string[]; readonly writeIsolation: EnforcementLevel | null }): Provenance {
  if (!input.baseline) return "unknown";
  if (input.ambiguousWith.length > 0 || input.writeIsolation !== "enforced") return "derived";
  return "observed";
}

export function bridgeProvenance(completeness: HistoryCompleteness): Provenance {
  switch (completeness) {
    case "complete": return "observed";
    case "partial":
    case "final-only": return "derived";
    case "unsupported": return "unknown";
  }
}

/** An observation made under a runtime other than the one measured is at most `derived`. */
export function demoteForVersion(provenance: Provenance, measured: string, actual: string | null): Provenance {
  if (provenance !== "observed") return provenance;
  if (actual === null || actual === "unknown" || !versionMatchesMeasured(measured, actual)) return "derived";
  return provenance;
}

const instant = (value: string | null, fallback: number): number => (value === null ? fallback : Date.parse(value));

function assignmentScope(node: OverlapNode): AssignmentScope {
  return { workspace: node.workspace, writeScope: node.writeScope, excludeScope: node.excludeScope ?? null };
}

/**
 * The executions that could have written what `target` wrote: same (or nested) workspace,
 * an active interval that meets the target's, and either a writer whose scope touches the
 * target's or any node whose runtime does not enforce write isolation — a read-only role on
 * a platform without a sandbox is not read-only in any sense evidence can rely on.
 * A node that never recorded a start is taken as active from its creation.
 */
export function ambiguousNodes(target: OverlapNode, others: readonly OverlapNode[]): readonly string[] {
  const targetStart = instant(target.startedAt, Number.NEGATIVE_INFINITY);
  const targetEnd = instant(target.endedAt, Number.POSITIVE_INFINITY);
  const targetScope = assignmentScope(target);
  const named = new Set<string>();
  for (const node of others) {
    if (node.executionId === target.executionId) continue;
    if (!within(node.workspace, target.workspace) && !within(target.workspace, node.workspace)) continue;
    const start = instant(node.startedAt, Number.NEGATIVE_INFINITY);
    const end = instant(node.endedAt, Number.POSITIVE_INFINITY);
    if (start > targetEnd || end < targetStart) continue;
    if (node.writeIsolation !== "enforced") { named.add(node.executionId); continue; }
    if (node.workspaceMode === "read-only") continue;
    // Two scopes that meet only where one of them excluded the meeting point never wrote
    // the same path (master plan 2b) — that is what the exclusion was for.
    if (sharedRegion(assignmentScope(node), targetScope) !== null) named.add(node.executionId);
  }
  return [...named].sort();
}

/** The paths whose status or content differs between two captures, plus what a moved HEAD committed. */
export function diffBaseline(before: GitBaselineV1, after: GitBaselineV1, changedBetweenHeads: readonly string[]): { readonly paths: readonly string[]; readonly commit: string | null } {
  const key = (entry: GitBaselineV1["dirty"][number]) => `${entry.status} ${entry.contentHash ?? ""}`;
  const beforeMap = new Map(before.dirty.map((entry) => [entry.path, key(entry)]));
  const afterMap = new Map(after.dirty.map((entry) => [entry.path, key(entry)]));
  const paths = new Set<string>();
  for (const [path, value] of beforeMap) if (afterMap.get(path) !== value) paths.add(path);
  for (const [path, value] of afterMap) if (beforeMap.get(path) !== value) paths.add(path);
  const commit = after.head !== before.head ? after.head : null;
  if (commit !== null) for (const path of changedBetweenHeads) paths.add(path);
  return { paths: [...paths].sort(), commit };
}

export function outsideScope(paths: readonly string[], writeScope: readonly string[] | null, workspace: string, excludeScope: readonly string[] | null = null): readonly string[] {
  const scope: AssignmentScope = { workspace, writeScope, excludeScope };
  return paths.filter((path) => !ownsPath(scope, path));
}

const VERIFY_ID = /^[a-z0-9][a-z0-9._-]*$/;

/** `change` or `verify:<id>`; trimmed, deduplicated, sorted — the list is part of the request fingerprint. */
export function parseRequiredEvidence(values: readonly string[]): readonly string[] {
  const parsed = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (value === "change") { parsed.add(value); continue; }
    if (value.startsWith("verify:") && VERIFY_ID.test(value.slice("verify:".length))) { parsed.add(value); continue; }
    throw new Error(`requiredEvidence entry \`${raw}\` is neither \`change\` nor \`verify:<id>\``);
  }
  return [...parsed].sort();
}

/**
 * `unsatisfied` names what is missing; `unknown` says a producer could not answer and
 * nothing is missing outright. Missing beats unknown: a verify that never ran and a change
 * that could not be read is a "no", not a "maybe". An empty `paths` satisfies nothing.
 * Nothing required is `unevaluated`, never `satisfied`: a vacuous truth is not a verdict.
 */
export function evaluateEvidence(required: readonly string[], items: readonly EvidenceItem[]): { readonly evaluation: EvidenceEvaluation; readonly missing: readonly string[] } {
  if (required.length === 0) return { evaluation: "unevaluated", missing: [] };
  const missing: string[] = [];
  let unknown = false;
  for (const requirement of required) {
    if (requirement === "change") {
      const changes = items.filter((item): item is EvidenceChangeItem => item.kind === "change");
      if (changes.some((item) => item.provenance !== "unknown" && item.paths.length > 0)) continue;
      if (changes.some((item) => item.provenance === "unknown")) { unknown = true; continue; }
      missing.push(requirement);
      continue;
    }
    const id = requirement.slice("verify:".length);
    const ran = items.find((item): item is EvidenceVerifyItem => item.kind === "verify" && item.commandId === id);
    if (ran !== undefined) { if (ran.exitCode !== 0) missing.push(requirement); continue; }
    if (items.some((item) => item.kind === "verify-skipped" && item.commandId === id)) { unknown = true; continue; }
    missing.push(requirement);
  }
  if (missing.length > 0) return { evaluation: "unsatisfied", missing };
  return { evaluation: unknown ? "unknown" : "satisfied", missing: [] };
}

export function evidenceDigest(items: readonly EvidenceItem[]): string {
  return sha256(canonicalJson(items));
}

// ---------------------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------------------

export interface GitBaselineProbe {
  /** `null` when `workspace` is not inside a git work tree. */
  capture(workspace: string): Promise<GitBaselineV1 | null>;
  changedBetween(workspace: string, from: string, to: string): Promise<readonly string[]>;
}

export type VerifyRun =
  | { readonly kind: "ran"; readonly exitCode: number; readonly durationMs: number; readonly tail: string }
  | { readonly kind: "timeout" };

export interface VerifyRunOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export type Verifier = (command: VerifyCommand, options: VerifyRunOptions) => Promise<VerifyRun>;

export interface VerifySettings {
  readonly project: string;
  readonly commands: readonly VerifyCommand[];
  /** `null` when the project declares no verify block. */
  readonly digest: string | null;
}

/** The history source of a composition that has no bridge: every runtime is `unsupported`. */
export function noHistoryBridges(): EvidenceHistorySource {
  return { for: (runtime) => unsupportedHistoryBridge(runtime) };
}

export type EvidenceHistorySource = Pick<HistoryBridgeRegistry, "for">;

export interface EvidenceCollectorDependencies {
  readonly executionsRoot: string;
  readonly graph: Pick<ExecutionGraphService, "findGraphFor">;
  readonly history: EvidenceHistorySource;
  readonly baseline: GitBaselineProbe;
  readonly verifier: Verifier;
  readonly verifySettings: (workspace: string) => Promise<VerifySettings>;
  readonly verifyTrusted: (project: string, digest: string) => boolean | Promise<boolean>;
  readonly now?: () => Date;
  /** Where `PATH` and `HOME` for a verify come from; nothing else of it is passed on. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface CollectedEvidence {
  readonly evidence: ExecutionEvidenceV1;
  readonly required: readonly string[];
  readonly evaluation: EvidenceEvaluation;
  readonly missing: readonly string[];
  /** The counters of the `usage` item, or null when nothing was measured. */
  readonly usage: UsageCounters | null;
  /** `evaluateBudget` over the node's budget and `usage` — `within` when no budget was declared. */
  readonly budgetStatus: BudgetStatus;
}

/** The usage the items carry and how it sits against the node's budget; nothing else decides `budgetStatus`. */
function usageOf(items: readonly EvidenceItem[], budget: ExecutionBudget | null): Pick<CollectedEvidence, "usage" | "budgetStatus"> {
  const usage = items.find((item): item is EvidenceUsageItem => item.kind === "usage")?.usage ?? null;
  return { usage, budgetStatus: evaluateBudget(budget, usage) };
}

interface PolicyView {
  readonly workspace: string;
  readonly workspaceMode: "read-only" | "workspace-write";
  readonly writeScope: readonly string[] | null;
  readonly excludeScope: readonly string[] | null;
  readonly runtime: RuntimeId | null;
  readonly enforcement: RuntimeEnforcementCapabilitiesV1 | null;
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try { raw = await readFile(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

async function readPolicy(executionsRoot: string, executionId: string): Promise<PolicyView | null> {
  const snapshot = await readJson(executionArtifactPaths(executionsRoot, executionId).policyFile);
  if (snapshot === null) return null;
  const { workspace, workspaceMode, runtime } = snapshot;
  if (typeof workspace !== "string" || (workspaceMode !== "read-only" && workspaceMode !== "workspace-write")) {
    throw new Error(`policy of ${executionId} names no workspace or mode`);
  }
  return {
    workspace,
    workspaceMode,
    writeScope: readWriteScope(snapshot),
    excludeScope: readExcludeScope(snapshot),
    runtime: typeof runtime === "string" && (RUNTIME_IDS as readonly string[]).includes(runtime) ? runtime as RuntimeId : null,
    enforcement: readEnforcement(snapshot),
  };
}

function overlapNodeOf(node: ExecutionNode, policy: PolicyView | null): OverlapNode {
  // A node whose policy cannot be read is a node that could have written anything: name it.
  return {
    executionId: node.executionId,
    workspace: policy?.workspace ?? "/",
    workspaceMode: policy?.workspaceMode ?? "workspace-write",
    writeScope: policy?.writeScope ?? null,
    excludeScope: policy?.excludeScope ?? null,
    writeIsolation: policy?.enforcement?.writeIsolation ?? null,
    startedAt: node.startedAt ?? node.createdAt,
    endedAt: node.endedAt,
  };
}

/** `evidence.json` as it stands; `null` when absent; refuses another version. */
export async function readExecutionEvidence(executionsRoot: string, executionId: string): Promise<ExecutionEvidenceV1 | null> {
  const parsed = await readJson(evidenceFile(executionsRoot, executionId));
  if (parsed === null) return null;
  if (parsed.version !== 1 || !Array.isArray(parsed.items)) throw new EvidenceError("EVIDENCE_CORRUPT", `evidence of ${executionId} is not a version 1 record`);
  return parsed as unknown as ExecutionEvidenceV1;
}

/** The refresh key of an item: one per producer, one per verify command. */
function sourceKey(item: EvidenceItem): string {
  return item.source === "alp-verifier" ? `alp-verifier:${item.commandId}` : item.source;
}

/**
 * Collect once, then only fill gaps: a second call on an execution whose items are all
 * answered returns the file as it is; otherwise only the producers with an `unknown` item
 * (or none at all) run again — a verify that already ran is never run twice. Nothing here
 * mutates the graph.
 */
export async function collectExecutionEvidence(input: { readonly executionId: string }, deps: EvidenceCollectorDependencies): Promise<CollectedEvidence> {
  const { executionId } = input;
  const now = deps.now ?? (() => new Date());
  const graph = await deps.graph.findGraphFor(executionId);
  const node = graph === null ? null : findNode(graph, executionId);
  if (graph === null || node === null) throw new EvidenceError("EXECUTION_NOT_FOUND", `execution \`${executionId}\` is not part of any execution graph`);
  if (!isTerminalNodeStatus(node.status)) throw new EvidenceError("EXECUTION_NOT_TERMINAL", `execution \`${executionId}\` is still ${node.status}; evidence is collected once it has ended`);
  const required = node.requiredEvidence ?? [];
  const budget = node.budget ?? null;

  const existing = await readExecutionEvidence(deps.executionsRoot, executionId);
  const historyIncomplete = existing !== null && (existing.completeness === "final-only" || existing.completeness === "unsupported");
  if (existing !== null && !existing.items.some((item) => item.provenance === "unknown") && !historyIncomplete) {
    return { evidence: existing, required, ...evaluateEvidence(required, existing.items), ...usageOf(existing.items, budget) };
  }
  const stale = new Set(existing?.items.filter((item) => item.provenance === "unknown").map(sourceKey) ?? []);
  const kept = (key: string): readonly EvidenceItem[] => existing?.items.filter((item) => sourceKey(item) === key) ?? [];
  const refresh = (key: string): boolean => existing === null || stale.has(key) || kept(key).length === 0;

  const policy = await readPolicy(deps.executionsRoot, executionId);
  if (policy === null) throw new EvidenceError("POLICY_UNREADABLE", `execution \`${executionId}\` has no policy.json`);
  const artifacts = executionArtifactPaths(deps.executionsRoot, executionId);
  const receipt = await readLaunchReceipt(join(artifacts.contextDirectory, "launch.json"));
  const measured = policy.enforcement?.measuredOn.runtimeVersion ?? null;
  const demote = (provenance: Provenance): Provenance =>
    measured === null ? (provenance === "observed" ? "derived" : provenance) : demoteForVersion(provenance, measured, receipt?.runtimeVersion ?? null);
  const scopeVerified = policy.enforcement?.writeScope === "enforced";
  const others = await Promise.all(graph.nodes
    .filter((other) => other.executionId !== executionId)
    .map(async (other) => overlapNodeOf(other, await readPolicy(deps.executionsRoot, other.executionId).catch(() => null))));
  const target = overlapNodeOf(node, policy);

  const items: EvidenceItem[] = [];

  // (1) git: the settle-time status against the baseline `materialize()` captured.
  if (refresh("git")) {
    const baselineRecord = await readJson(baselineFile(artifacts.contextDirectory));
    const before = (baselineRecord?.baseline ?? null) as GitBaselineV1 | null;
    const after = before === null ? null : await deps.baseline.capture(policy.workspace);
    if (before === null || after === null) {
      items.push({ kind: "change", provenance: "unknown", source: "git", paths: [], commit: null, outsideScope: [], outsideScopeVerified: scopeVerified, ambiguousWith: [] });
    } else {
      const committed = after.head !== before.head && before.head !== null && after.head !== null
        ? await deps.baseline.changedBetween(policy.workspace, before.head, after.head) : [];
      const diff = diffBaseline(before, after, committed);
      const ambiguousWith = ambiguousNodes(target, others);
      items.push({
        kind: "change",
        provenance: demote(gitProvenance({ baseline: true, ambiguousWith, writeIsolation: policy.enforcement?.writeIsolation ?? null })),
        source: "git",
        paths: diff.paths,
        commit: diff.commit,
        outsideScope: outsideScope(diff.paths, policy.writeScope, policy.workspace, policy.excludeScope),
        outsideScopeVerified: scopeVerified,
        ambiguousWith,
      });
    }
  } else items.push(...kept("git"));

  // (2) the runtime's own transcript, mirrored under the child's context — never the Thread.
  let completeness: HistoryCompleteness = existing?.completeness ?? "unsupported";
  let delta: HistoryDelta | null = null;
  // A transcript that could not be read last time is asked for again, whatever was kept.
  if (refresh("history-bridge") || historyIncomplete) {
    delta = await collectDelta(deps, artifacts.contextDirectory, executionId, policy);
    completeness = delta.completeness;
    const provenance = demote(bridgeProvenance(delta.completeness));
    for (const entry of delta.entries) {
      if (entry.kind === "tool") items.push({ kind: "tool-call", provenance, source: "history-bridge", ref: entry });
      else if (entry.kind === "change") {
        items.push({
          kind: "change", provenance, source: "history-bridge", paths: entry.paths, commit: entry.commit,
          outsideScope: outsideScope(entry.paths, policy.writeScope, policy.workspace, policy.excludeScope), outsideScopeVerified: scopeVerified, ambiguousWith: [],
        });
      }
    }
    // Usage adds onto what earlier passes counted — the bridge only hands back lines past its cursor.
    const previous = countersOf(await readExecutionUsage(deps.executionsRoot, executionId));
    const usage = accumulateUsage(previous, delta.usageDelta);
    if (usage !== null) {
      if (usage !== previous) {
        await writeExecutionUsage(deps.executionsRoot, { version: 1, executionId, source: "history-bridge", completeness, collectedAt: now().toISOString(), ...usage });
      }
      items.push({ kind: "usage", provenance, source: "history-bridge", usage, budget, status: evaluateBudget(budget, usage) });
    }
  } else items.push(...kept("history-bridge"));

  // (3) the boundary ALP itself recorded when the node settled.
  if (refresh("runtime-event")) {
    const previousBoundary = existing?.items.find((item): item is EvidenceBoundaryItem => item.kind === "boundary") ?? null;
    items.push({
      kind: "boundary",
      provenance: demote("observed"),
      source: "runtime-event",
      ref: {
        kind: "boundary", nativeId: null, createdAt: node.endedAt ?? now().toISOString(), sequence: 0,
        outcome: node.status as ThreadExecutionOutcome, runtime: policy.runtime, historyCompleteness: completeness,
        pinnedVersion: delta?.pinnedVersion ?? previousBoundary?.ref.pinnedVersion ?? null,
        collected: delta === null ? kept("history-bridge").length : delta.entries.length,
        skipped: delta?.skipped ?? previousBoundary?.ref.skipped ?? 0,
      },
    });
  } else items.push(...kept("runtime-event"));

  // (4) what the agent said, by digest only.
  if (refresh("agent-output")) {
    const state = await readJson(artifacts.stateFile).catch(() => null);
    const output = state?.output;
    if (output !== undefined && output !== null) {
      items.push({ kind: "output", provenance: "self-reported", source: "agent-output", digest: sha256(typeof output === "string" ? output : canonicalJson(output)) });
    }
  } else items.push(...kept("agent-output"));

  // (5) the verify commands the parent required, only under a trusted block.
  let settings: VerifySettings | null = null;
  for (const requirement of required) {
    if (!requirement.startsWith("verify:")) continue;
    const commandId = requirement.slice("verify:".length);
    const key = `alp-verifier:${commandId}`;
    if (!refresh(key)) { items.push(...kept(key)); continue; }
    settings ??= await deps.verifySettings(policy.workspace);
    const command = settings.commands.find((entry) => entry.id === commandId);
    const skipped = (reason: VerifySkipReason): EvidenceVerifySkippedItem => ({ kind: "verify-skipped", provenance: "unknown", source: "alp-verifier", commandId, reason });
    if (command === undefined || settings.digest === null) { items.push(skipped("not-configured")); continue; }
    if (!(await deps.verifyTrusted(settings.project, settings.digest))) { items.push(skipped("untrusted")); continue; }
    const env = deps.env ?? process.env;
    const startedAt = now().toISOString();
    const run = await deps.verifier(command, { cwd: resolve(policy.workspace, command.cwd), env: { PATH: env.PATH ?? "", HOME: env.HOME ?? "" }, timeoutMs: command.timeoutMs });
    const endedAt = now().toISOString();
    if (run.kind === "timeout") { items.push(skipped("timeout")); continue; }
    items.push({
      kind: "verify", provenance: "observed", source: "alp-verifier", commandId, commandDigest: sha256(canonicalJson(command)),
      exitCode: run.exitCode, durationMs: run.durationMs, tail: sanitizeText(run.tail, VERIFY_TAIL_MAX_BYTES),
      // A verify starts only once the target is terminal, so any node already ended by then
      // — the target's own siblings that finished first — cannot have written during the run.
      ambiguousWith: ambiguousNodes({ ...target, startedAt, endedAt }, others.filter((node) => node.endedAt === null || node.endedAt > startedAt)),
    });
  }

  const evidence: ExecutionEvidenceV1 = {
    version: 1,
    executionId,
    requestId: node.requestId,
    collectedAt: now().toISOString(),
    completeness,
    items,
    digest: evidenceDigest(items),
  };
  await atomicRuntimeFile(evidenceFile(deps.executionsRoot, executionId), `${JSON.stringify(evidence, null, 2)}\n`);
  return { evidence, required, ...evaluateEvidence(required, items), ...usageOf(items, budget) };
}

/** The bridge's delta for this execution, appended to `<context>/history/entries.json`; a bridge that fails is `final-only`. */
async function collectDelta(deps: EvidenceCollectorDependencies, contextDirectory: string, executionId: string, policy: PolicyView): Promise<HistoryDelta> {
  const historyDirectory = join(contextDirectory, "history");
  const cursorFile = join(historyDirectory, "cursor.json");
  const entriesFile = join(historyDirectory, "entries.json");
  const cursor = (await readJson(cursorFile).catch(() => null)) as RuntimeHistoryCursor | null;
  const bridge = deps.history.for(policy.runtime);
  let delta: HistoryDelta;
  try {
    delta = await bridge.collectDelta({ execution: { executionId, runtime: policy.runtime, workspace: policy.workspace, contextDirectory }, cursor });
  } catch {
    return { entries: [], cursor, completeness: "final-only", pinnedVersion: null, skipped: 0, usageDelta: null };
  }
  if (delta.completeness === "unsupported") return delta;
  await mkdir(historyDirectory, { recursive: true, mode: 0o700 });
  const previous = await readFile(entriesFile, "utf8").then((raw) => JSON.parse(raw) as CollectedEntry[]).catch((): CollectedEntry[] => []);
  await atomicRuntimeFile(entriesFile, `${JSON.stringify([...previous, ...delta.entries], null, 2)}\n`);
  if (delta.cursor !== null) await atomicRuntimeFile(cursorFile, `${JSON.stringify(delta.cursor)}\n`);
  return delta;
}
