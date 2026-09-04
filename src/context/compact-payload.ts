import type { RuntimeId } from "../agents/types";
import type {
  CompactEventV1,
  CompactPhase,
  CompactPhaseWire,
  CompactSource,
  CompactTrigger,
} from "./types";

/**
 * Per-runtime whitelist of hook payload keys a journal line may carry.
 *
 * A whitelist, not a blacklist, because a payload is a floor and not a ceiling: the schemas
 * compiled into both binaries under-declare what they actually send. A live Claude
 * `SessionStart` on 2026-09-03 carried `seconds_since_last_response`, `context_tokens`,
 * `prompt_cache_likely_expired` and `estimated_cache_write_usd` that no schema mentions, and
 * carried a different set per `source`. A blacklist would have leaked every one of them into
 * a file ALP keeps.
 *
 * What is deliberately absent, and why:
 * - `compact_summary` (Claude, 22-32 KB measured) — invariant 8. It is provider history the
 *   runtime already holds, and one line of it would blow the 16 KiB journal line limit.
 * - `custom_instructions` (Claude `PreCompact`) — free text from the user's own prompt.
 * - `transcript_path`, `cwd` — paths ALP already knows and does not need duplicated per line.
 * - `hook_event_name` — the phase comes from the hook's argv, which is the value ALP
 *   controls; trusting the payload's own name for it would let the payload pick its bucket.
 * - `permission_mode` — policy state, owned by ALP, not something to re-learn from a hook.
 */
const SOURCE_WHITELIST: Readonly<Record<RuntimeId, readonly string[]>> = Object.freeze({
  claude: Object.freeze(["session_id", "trigger", "model", "prompt_id", "agent_id", "agent_type"]),
  codex: Object.freeze(["session_id", "trigger", "model", "turn_id", "agent_id", "agent_type"]),
});

/** Per §6 size limits. A whitelisted key with an over-long value is truncated, not dropped. */
const MAX_VALUE_LENGTH = 256;

/**
 * Which key carries the runtime's own id for the event.
 *
 * Measured 2026-09-03/04: Claude's `prompt_id` is the same value across `PreCompact`,
 * `SessionStart(source="compact")` and `PostCompact` of one compaction. Codex's `turn_id`
 * behaves differently by launch mode — one id per compaction in an inherited TTY, but a
 * single root-turn id shared by every compaction under `exec` (23 of them in one session).
 * That is why `dedupeKey` prefers an ALP-assigned sequence; see `normalizeCompactEvent`.
 */
const EVENT_ID_KEY: Readonly<Record<RuntimeId, string>> = Object.freeze({
  claude: "prompt_id",
  codex: "turn_id",
});

const PHASE_BY_WIRE: Readonly<Record<CompactPhaseWire, CompactPhase>> = Object.freeze({
  pre: "started",
  post: "completed",
});

export interface NormalizeCompactEventInput {
  readonly runtime: RuntimeId;
  readonly phase: CompactPhaseWire;
  readonly source: CompactSource;
  readonly observedAt: string;
  /**
   * The compaction's ordinal within its session, assigned by ALP when the line is appended
   * and shared by the `pre`/`post` pair. Required for Codex, where the runtime's own id
   * cannot separate one compaction from the next under `exec`.
   */
  readonly sequence?: number;
}

export type CompactPayloadResult<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly issues: readonly string[] };

function isRuntimeId(value: unknown): value is RuntimeId {
  return value === "claude" || value === "codex";
}

/**
 * Copy the whitelisted scalars out of a raw hook payload.
 *
 * Scalars only: a whitelisted key holding an object or array is dropped rather than
 * stringified, because the point is to keep the line small and predictable, and nothing ALP
 * reads back needs a nested value. Numbers and booleans are kept as their string spelling so
 * a journal line has exactly one value type.
 */
export function filterCompactSource(runtime: RuntimeId, payload: unknown): CompactSource {
  if (typeof payload !== "object" || payload === null) return Object.freeze({});
  const raw = payload as Record<string, unknown>;
  const source: Record<string, string> = {};
  for (const key of SOURCE_WHITELIST[runtime]) {
    const value = raw[key];
    if (typeof value === "string") source[key] = value.slice(0, MAX_VALUE_LENGTH);
    else if (typeof value === "number" || typeof value === "boolean") source[key] = String(value);
  }
  return Object.freeze(source);
}

function readTrigger(source: CompactSource): CompactTrigger {
  const trigger = source.trigger;
  return trigger === "manual" || trigger === "auto" ? trigger : "unknown";
}

/**
 * Turn one journal line into a `CompactEventV1`, or say why it cannot be one.
 *
 * Rejects a structurally wrong line — unknown runtime, unknown phase, a `session_id` that is
 * present but not a string — because those mean the line was written by something other than
 * ALP's hook and guessing at it would put fiction in the reduced state. Tolerates a bad
 * `trigger`, which degrades to `"unknown"`: the type has that state precisely so a future
 * trigger value cannot fail an otherwise good replay.
 */
export function normalizeCompactEvent(
  input: NormalizeCompactEventInput,
): CompactPayloadResult<CompactEventV1> {
  const issues: string[] = [];
  if (!isRuntimeId(input.runtime)) issues.push(`runtime: unknown runtime ${JSON.stringify(input.runtime)}`);
  if (input.phase !== "pre" && input.phase !== "post") {
    issues.push(`phase: expected "pre" or "post", received ${JSON.stringify(input.phase)}`);
  }
  if (typeof input.observedAt !== "string" || input.observedAt.length === 0) {
    issues.push("observedAt: expected a non-empty timestamp");
  }
  if (typeof input.source !== "object" || input.source === null) {
    issues.push("source: expected an object");
  }
  if (issues.length > 0) return { ok: false, issues: Object.freeze(issues) };

  const source = filterCompactSource(input.runtime, input.source);
  const runtimeSessionId = source.session_id ?? null;
  const runtimeEventId = source[EVENT_ID_KEY[input.runtime]] ?? null;

  // The compaction's identity, in the order of how well each spelling was measured to
  // separate one compaction from the next. `observedAt` last so that a line missing every
  // id still dedupes against a re-append of itself rather than against a different event.
  const identity = input.sequence === undefined
    ? runtimeEventId ?? input.observedAt
    : String(input.sequence);

  return {
    ok: true,
    value: Object.freeze({
      dedupeKey: [input.runtime, runtimeSessionId ?? "-", identity, PHASE_BY_WIRE[input.phase]].join("|"),
      runtime: input.runtime,
      phase: PHASE_BY_WIRE[input.phase],
      trigger: readTrigger(source),
      runtimeSessionId,
      runtimeEventId,
      observedAt: input.observedAt,
    }),
  };
}
