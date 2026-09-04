import type { RuntimeId } from "../agents/types";

/**
 * What a runtime emits around its own compaction, as measured rather than as documented.
 * Pinned per adapter against a specific CLI version; see the `compact` member on each
 * adapter for the version and probe date behind the values.
 *
 * Deliberately three booleans. `stableEventId`, `triggerMetadata`, `tokenMetadata` and
 * `postCompactAdditionalContext` were all measured to be constants across both runtimes,
 * so a capability flag for them would only ever select one branch.
 */
export interface CompactCapabilities {
  readonly preCompact: boolean;
  readonly postCompact: boolean;
  readonly sessionStartAfterCompact: boolean;
}

/** The journal's two phases. `pre`/`post` on the wire, from the hook's own argv. */
export type CompactPhaseWire = "pre" | "post";

/**
 * The same two phases once normalized. `started` without a matching `completed` is an
 * ordinary state, not corruption: a Claude session on 2026-09-04 emitted `PreCompact` for a
 * compaction that never finished, then a second one that did.
 */
export type CompactPhase = "started" | "completed";

/**
 * Both runtimes always send `trigger`, so `unknown` is not a measured state — it is what a
 * malformed or future payload degrades to, so that one odd line cannot fail a whole replay.
 */
export type CompactTrigger = "manual" | "auto" | "unknown";

/**
 * The scalars a journal line is allowed to carry out of a hook payload. Values only; every
 * key is whitelisted per runtime in `compact-payload.ts`.
 */
export type CompactSource = Readonly<Record<string, string>>;

/**
 * The durable continuity file, `context/checkpoint.json`. Written only by
 * `ExecutionService.prepare()` (seed) and `alp context pin|unpin` — no other writer exists,
 * per invariant 3.
 *
 * Dropped versus the v1 draft of this plan: `generation` (derived from the journal, not
 * stored), `state` (duplicated `openItems`), `evidence` (belongs to a report, not to
 * continuity — YAGNI).
 */
export interface ContinuityCheckpointV1 {
  readonly version: 1;
  readonly executionId: string;
  readonly policyHash: string;
  /** `null` until a runtime adapter has actually launched this execution. */
  readonly runtime: RuntimeId | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Seeded from `capsule.task`. This is what keeps a fresh checkpoint from being empty —
   * an interactive execution's task is a sentinel string instead, which the renderer skips.
   */
  readonly objective: string | null;
  readonly decisions: readonly ContinuityPin[];
  readonly constraints: readonly ContinuityPin[];
  readonly openItems: readonly ContinuityPin[];
  readonly nextActions: readonly ContinuityPin[];
  readonly integrity: { readonly checkpointSha256: string };
}

/** A single pinned line. One sentence, not a summary — enforced at the CLI, not here. */
export interface ContinuityPin {
  readonly id: string;
  readonly text: string;
  readonly source: "execution" | "principal" | "agent";
  readonly createdAt: string;
}

/** One compaction event, derived from a journal line. Never read from disk in this shape. */
export interface CompactEventV1 {
  readonly dedupeKey: string;
  readonly runtime: RuntimeId;
  readonly phase: CompactPhase;
  readonly trigger: CompactTrigger;
  readonly runtimeSessionId: string | null;
  readonly runtimeEventId: string | null;
  readonly observedAt: string;
}

/**
 * Reduced from the whole journal. `pending` is a `started` with no `completed` yet, which
 * happens both because a compaction was abandoned and, on Claude, because reinjection
 * arrives before `PostCompact` does — so a reader must never treat it as an error.
 */
export interface CompactionStateV1 {
  readonly generation: number;
  readonly pending: CompactEventV1 | null;
  readonly lastCompleted: CompactEventV1 | null;
}
