import { describe, expect, it } from "vitest";
import { filterCompactSource, normalizeCompactEvent } from "../../src/context/compact-payload";

/**
 * Fixtures are the field sets measured on 2026-09-04 by
 * `scripts/probe-compact-hooks.cjs` (Claude Code 2.1.240, Codex CLI 0.153.0, win32,
 * inherited TTY, `trigger=manual`), with every identifier replaced by a readable stand-in.
 * The shapes are load-bearing — notably that Claude's compact payloads carry no `model`
 * while its `SessionStart` does, and that only Claude carries `compact_summary`.
 */
function claudePreCompact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "claude-session-1",
    transcript_path: "/home/anhlp/.claude/projects/slug/claude-session-1.jsonl",
    cwd: "/home/anhlp/projects/alp-code",
    prompt_id: "claude-prompt-7",
    hook_event_name: "PreCompact",
    trigger: "manual",
    custom_instructions: null,
    ...overrides,
  };
}

function claudePostCompact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...claudePreCompact(),
    hook_event_name: "PostCompact",
    custom_instructions: undefined,
    // 22-32 KB in the real payload. Invariant 8: never written, at any size.
    compact_summary: "## Summary\nThe principal asked for a compact bridge...",
    ...overrides,
  };
}

function codexPreCompact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "codex-session-1",
    turn_id: "codex-turn-3",
    transcript_path: "/home/anhlp/.codex/sessions/2026/09/04/rollout.jsonl",
    cwd: "/home/anhlp/projects/alp-code",
    hook_event_name: "PreCompact",
    model: "gpt-5.6-sol",
    trigger: "manual",
    ...overrides,
  };
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; issues: readonly string[] }): T {
  if (!result.ok) throw new Error(`expected ok, got issues: ${result.issues.join("; ")}`);
  return result.value;
}

describe("filterCompactSource", () => {
  it("keeps only whitelisted keys from a Claude payload", () => {
    expect(filterCompactSource("claude", claudePreCompact())).toEqual({
      session_id: "claude-session-1",
      prompt_id: "claude-prompt-7",
      trigger: "manual",
    });
  });

  it("keeps only whitelisted keys from a Codex payload", () => {
    expect(filterCompactSource("codex", codexPreCompact())).toEqual({
      session_id: "codex-session-1",
      turn_id: "codex-turn-3",
      model: "gpt-5.6-sol",
      trigger: "manual",
    });
  });

  it("never lets compact_summary through, however it is spelled", () => {
    const filtered = filterCompactSource("claude", claudePostCompact());
    expect(filtered).not.toHaveProperty("compact_summary");
    expect(JSON.stringify(filtered)).not.toContain("Summary");
  });

  it("drops fields the binary sends but no schema declares", () => {
    // Measured on a live Claude SessionStart: telemetry the compiled Zod schema never
    // mentions. A blacklist would have written every one of these to disk.
    const filtered = filterCompactSource("claude", claudePreCompact({
      context_tokens: 91_000,
      estimated_cache_write_usd: 0.42,
      prompt_cache_likely_expired: false,
      seconds_since_last_response: 12,
    }));
    expect(Object.keys(filtered).sort()).toEqual(["prompt_id", "session_id", "trigger"]);
  });

  it("does not read a Codex identifier out of a Claude payload, or the reverse", () => {
    expect(filterCompactSource("claude", codexPreCompact())).not.toHaveProperty("turn_id");
    expect(filterCompactSource("codex", claudePreCompact())).not.toHaveProperty("prompt_id");
  });

  it("truncates an over-long value rather than dropping the key", () => {
    const filtered = filterCompactSource("claude", claudePreCompact({ session_id: "s".repeat(400) }));
    expect(filtered.session_id).toHaveLength(256);
  });

  it("keeps scalars as strings and drops nested values", () => {
    const filtered = filterCompactSource("codex", codexPreCompact({
      model: 5,
      agent_id: { nested: "object" },
      agent_type: ["array"],
    }));
    expect(filtered.model).toBe("5");
    expect(filtered).not.toHaveProperty("agent_id");
    expect(filtered).not.toHaveProperty("agent_type");
  });

  it("returns an empty source for a payload that is not an object", () => {
    expect(filterCompactSource("claude", null)).toEqual({});
    expect(filterCompactSource("claude", "PreCompact")).toEqual({});
  });
});

describe("normalizeCompactEvent", () => {
  const observedAt = "2026-09-04T01:41:00.261Z";

  it("maps the wire phase to the journal phase", () => {
    const started = unwrap(normalizeCompactEvent({
      runtime: "claude", phase: "pre", source: filterCompactSource("claude", claudePreCompact()), observedAt,
    }));
    const completed = unwrap(normalizeCompactEvent({
      runtime: "claude", phase: "post", source: filterCompactSource("claude", claudePostCompact()), observedAt,
    }));
    expect(started.phase).toBe("started");
    expect(completed.phase).toBe("completed");
  });

  it("reads session id and Claude's prompt_id as the runtime event id", () => {
    const event = unwrap(normalizeCompactEvent({
      runtime: "claude", phase: "pre", source: filterCompactSource("claude", claudePreCompact()), observedAt,
    }));
    expect(event.runtimeSessionId).toBe("claude-session-1");
    expect(event.runtimeEventId).toBe("claude-prompt-7");
  });

  it("reads Codex's turn_id as the runtime event id", () => {
    const event = unwrap(normalizeCompactEvent({
      runtime: "codex", phase: "pre", source: filterCompactSource("codex", codexPreCompact()), observedAt,
    }));
    expect(event.runtimeSessionId).toBe("codex-session-1");
    expect(event.runtimeEventId).toBe("codex-turn-3");
  });

  it("carries both measured trigger values through", () => {
    for (const trigger of ["manual", "auto"] as const) {
      const event = unwrap(normalizeCompactEvent({
        runtime: "codex",
        phase: "pre",
        source: filterCompactSource("codex", codexPreCompact({ trigger })),
        observedAt,
      }));
      expect(event.trigger).toBe(trigger);
    }
  });

  it("degrades an unrecognised trigger instead of failing the line", () => {
    const event = unwrap(normalizeCompactEvent({
      runtime: "codex",
      phase: "pre",
      source: filterCompactSource("codex", codexPreCompact({ trigger: "scheduled" })),
      observedAt,
    }));
    expect(event.trigger).toBe("unknown");
  });

  it("rejects a line whose required fields are the wrong type", () => {
    const wrongPhase = normalizeCompactEvent({
      runtime: "claude", phase: "during" as never, source: {}, observedAt,
    });
    const wrongRuntime = normalizeCompactEvent({
      runtime: "gemini" as never, phase: "pre", source: {}, observedAt,
    });
    const noTimestamp = normalizeCompactEvent({
      runtime: "claude", phase: "pre", source: {}, observedAt: "",
    });
    expect(wrongPhase.ok).toBe(false);
    expect(wrongRuntime.ok).toBe(false);
    expect(noTimestamp.ok).toBe(false);
    if (!wrongRuntime.ok) expect(wrongRuntime.issues.join()).toContain("runtime");
  });

  it("separates the pre and post of one compaction, and dedupes a repeated line", () => {
    const line = {
      runtime: "codex" as const,
      source: filterCompactSource("codex", codexPreCompact()),
      observedAt,
      sequence: 1,
    };
    const started = unwrap(normalizeCompactEvent({ ...line, phase: "pre" }));
    const completed = unwrap(normalizeCompactEvent({ ...line, phase: "post" }));
    const replayed = unwrap(normalizeCompactEvent({ ...line, phase: "pre" }));
    expect(started.dedupeKey).not.toBe(completed.dedupeKey);
    expect(started.dedupeKey).toBe(replayed.dedupeKey);
  });

  it("keeps Codex compactions apart when they share one turn_id", () => {
    // The measured `codex exec` case: 23 auto-compactions in one session, every one of them
    // carrying the same root turn_id. Without ALP's own sequence they collapse into one.
    const shared = { runtime: "codex" as const, phase: "pre" as const, source: filterCompactSource("codex", codexPreCompact()), observedAt };
    const first = unwrap(normalizeCompactEvent({ ...shared, sequence: 1 }));
    const second = unwrap(normalizeCompactEvent({ ...shared, sequence: 2 }));
    const withoutSequence = unwrap(normalizeCompactEvent(shared));
    const alsoWithoutSequence = unwrap(normalizeCompactEvent(shared));
    expect(first.dedupeKey).not.toBe(second.dedupeKey);
    expect(withoutSequence.dedupeKey).toBe(alsoWithoutSequence.dedupeKey);
  });

  it("builds a dedupe key that survives a payload carrying no identifiers at all", () => {
    const event = unwrap(normalizeCompactEvent({
      runtime: "claude", phase: "pre", source: {}, observedAt,
    }));
    expect(event.runtimeSessionId).toBeNull();
    expect(event.runtimeEventId).toBeNull();
    expect(event.dedupeKey).toContain(observedAt);
  });

  it("normalizes a post payload without leaking the summary into the event", () => {
    const event = unwrap(normalizeCompactEvent({
      runtime: "claude",
      phase: "post",
      source: filterCompactSource("claude", claudePostCompact()),
      observedAt,
    }));
    expect(JSON.stringify(event)).not.toContain("Summary");
  });
});
