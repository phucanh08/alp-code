# Paseo 0.7.2 — Compaction Reference

## Scope

Read-only inspection of the locally installed Paseo packages:

- CLI: `paseo 0.7.2`.
- Server: `@getpaseo/server 0.7.2`.
- Protocol: `@getpaseo/protocol 0.7.2`.

Primary sources:

- `/Users/anhlp/.npm-global/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/server/server/agent/providers/claude/agent.js`
- `/Users/anhlp/.npm-global/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/server/server/agent/providers/codex-app-server-agent.js`
- `/Users/anhlp/.npm-global/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/server/server/agent/agent-sdk-types.d.ts`
- `/Users/anhlp/.npm-global/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/protocol/dist/agent-types.d.ts`
- `/Users/anhlp/.npm-global/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/server/server/agent/activity-curator.js`

This report describes observed implementation, not a public compatibility promise.

## Runtime transport cross-check

Paseo's provider events are not assumed to be CLI-hook contracts. The target transports were checked separately on 2026-09-03:

- Installed Claude Code: `2.1.259`.
- Installed Codex CLI: `0.153.0`.
- Claude's official hook reference documents `PreCompact`, `PostCompact`, and `SessionStart` with `source: "compact"`. It also exposes `PostCompact.compact_summary`; ALP intentionally ignores that content.
- Codex upstream `compact.rs` invokes pre-compact before compaction and post-compact only after a successful result. Its config schema includes `PreCompact` and `PostCompact` hook groups.

Primary transport references:

- <https://code.claude.com/docs/en/hooks#precompact>
- <https://code.claude.com/docs/en/hooks#postcompact>
- <https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs>
- <https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json>

These sources establish that hook surfaces exist, not that every launch mode dispatches them identically. ALP still requires the Phase CB-0 live probe for inherited-TTY behavior, enabled features, payload shape, ordering, output handling, and OS-specific quoting.

## What Paseo actually does

### 1. Provider owns compaction

Paseo does not implement one cross-provider summarizer. It lets each provider compact its own session and translates provider events into a neutral timeline item.

The neutral contract is intentionally small:

```ts
interface CompactionTimelineItem {
  type: "compaction";
  status: "loading" | "completed";
  trigger?: "auto" | "manual";
  preTokens?: number;
}
```

The activity projection renders only `[Compacted]`. It does not expose or promote the provider's compact summary as a provider-neutral assistant message.

### 2. Claude mapping

Claude provider behavior:

- `status: "compacting"` becomes a loading compaction timeline item.
- `subtype: "compact_boundary"` becomes completed.
- Metadata accepts multiple compatible spellings: `compact_metadata`, `compactMetadata`, `compactionMetadata`.
- Trigger maps to `manual` or `auto`.
- `preTokens` and `postTokens` are read when present.
- Context usage is reset after compaction and updated from `postTokens`.
- The first synthetic user entry observed while `compacting` is suppressed.
- During history reconstruction, `compact_boundary` becomes a compaction marker.
- Entries marked `isCompactSummary` are omitted from the neutral history projection.

Relevant installed-source ranges:

- Claude live event mapping: approximately lines 3431–3453.
- Usage reset: approximately lines 1370–1483.
- Metadata compatibility parser: approximately lines 4483–4504.
- History reconstruction/noise filtering: approximately lines 4709–4730.

### 3. Codex mapping

Paseo uses Codex app-server, not ordinary inherited-TTY CLI hooks.

Manual `/compact` is handled out of band:

```text
/compact
  → thread/compact/start { threadId }
```

Compaction can then be reported through two channels:

- `thread/compacted` notification;
- completed `contextCompaction` item.

Paseo correlates and deduplicates them with:

- pending manual-start counter;
- item-id → trigger map;
- pending root item IDs;
- anonymous pending count;
- unpaired notification completion count;
- unpaired item completion count.

It also handles:

- late completion for an older item;
- item without ID;
- turn ending before the provider emits item completion;
- root and subagent compaction separately;
- history reconstruction from stored `contextCompaction` items.

Relevant installed-source ranges:

- Neutral history mapping: approximately lines 1387–1392.
- `thread/compacted` validation: approximately lines 1621 and 1906–1916.
- Manual compact command: approximately lines 3684–3760.
- Duplicate completion handling: approximately lines 4251–4275 and 4754–4769.
- Pending correlation state: approximately lines 4664–4742.
- Start-item mapping: approximately lines 5045–5055.

### 4. Timeline is separate from provider history

Paseo exposes compaction as a timeline lifecycle fact. Provider history remains provider-owned. Compact-summary content is not conflated with the lifecycle marker.

This separation avoids:

- showing the same summary twice;
- treating provider-generated history text as a new assistant answer;
- coupling clients to provider summary shape;
- losing compaction observability when reconstructing a resumed session.

### 5. Usage after compact is new state

Claude mapping clears stale stream counters when compact completes. If `postTokens` exists, it becomes the new context-window usage. Paseo does not subtract guessed values from the previous usage.

### 6. Compatibility is tolerant at the edge

Provider payload parsers accept multiple field spellings and passthrough unknown fields, then normalize to a narrow internal type. Invalid known notifications become explicit invalid-payload events rather than crashing the provider loop.

## Patterns ALP should adopt

1. **Provider-native compaction.** Keep runtime as owner of transcript and summary.
2. **Neutral lifecycle event.** Normalize to started/completed/interrupted plus trigger and optional token counts.
3. **Separate checkpoint from compact event.** ALP continuity pins are not the provider compact summary.
4. **Idempotent reducer.** Duplicate, delayed and anonymous events must not increment generation twice.
5. **History replay.** Rebuild ALP compaction state from its own durable event journal.
6. **Usage reset.** Treat post-compact usage as a new measurement, never inferred subtraction.
7. **Noise suppression.** Do not reinject provider compact summary as a fresh assistant/user message.
8. **Out-of-band manual compact.** Preserve native `/compact`; do not turn it into a normal user task.
9. **Execution scope.** Root and delegated executions keep separate compact state.
10. **Versioned capability evidence.** Pin behavior to measured runtime/version, not provider name alone.

## Patterns ALP should not copy

1. **Codex app-server transport.** ALP's chosen scope is ordinary Claude Code/Codex CLI processes.
2. **In-memory correlation only.** ALP hook processes are short-lived; correlation must survive through durable state/journal.
3. **Mark missing completion as successful.** Paseo closes a loading UI row at turn end. ALP integrity state should call this `interrupted` or `unknown`, not `completed`.
4. **Provider UI timeline breadth.** ALP needs compact diagnostics, not Paseo's complete agent activity product.
5. **Provider summary promotion.** Native summary should stay inside the native session unless a future explicit, validated export is added.

## Impact on the ALP plan

The previous draft made `nativeCompact.summary` part of `ContinuityCheckpointV1`. Remove it.

Replace it with two independent models:

```text
ContinuityCheckpointV1
  = explicit durable semantic pins owned by ALP

CompactionLifecycleEventV1
  = provider-neutral lifecycle metadata observed by ALP
```

Store an append-only bounded event journal plus a projected compaction state. Reinject only the continuity checkpoint. Native summary remains in Claude/Codex history and is not duplicated.

## Confidence and remaining unknowns

High confidence:

- Paseo's neutral event shape.
- Claude compact-boundary and usage handling.
- Codex duplicate-channel correlation under app-server.
- Summary filtering from neutral history.

## Resolved 2026-09-03 (post-report)

Four of the five open items were settled by reading the installed binaries' own schemas, not by
live probe. Details and evidence in `plan.md` §Runtime capability; gate table filled in Phase CB-0.

| Was unknown | Answer |
|---|---|
| Claude CLI hook payloads (2.1.259) | `PreCompact{trigger, custom_instructions}`, `PostCompact{trigger, compact_summary}`, over base `{session_id, transcript_path, cwd, prompt_id?, permission_mode?, agent_id?, agent_type?}` |
| Codex CLI hook payloads (0.153.0) | Both events identical: `{cwd, hook_event_name, model, session_id, transcript_path, trigger, turn_id, agent_id?, agent_type?}`; no `compact_summary` |
| Codex `SessionStart` after compact | Yes — `session-start.command.input.source` enum contains `"compact"`; Claude's contains it too |
| Stable event IDs via CLI hooks | Codex `turn_id` (required); Claude `prompt_id` (optional) |
| Hook exit/output semantics on Windows | **Still unknown.** Remains the CB-0 gate, alongside whether hooks dispatch at all in ALP's inherited-TTY mode |

Live-probe additions 2026-09-04 (`scripts/probe-compact-hooks.cjs`, darwin, headless):

| Was unknown | Answer |
|---|---|
| Do the compact hooks actually dispatch | Yes on both. Claude `manual` via `/compact`; Codex `auto`, 6 times in one 90s session |
| Event order around reinjection | **Opposite on the two runtimes.** Claude `PreCompact → SessionStart(compact) → PostCompact`; Codex `PreCompact → PostCompact → SessionStart(compact)`. Only common point: `SessionStart(compact)` is where reinjection happens |
| Is `turn_id` a per-compaction ID on Codex | **No.** All 6 compactions plus `Stop` shared one `turn_id` — it is the root turn. Codex needs an ALP-issued sequence for dedupe; Claude's `prompt_id` does correlate the three events of one compaction |
| Does injected context survive compaction | Yes on both, end to end. Codex's final answer after 6 auto-compactions was the marker from the newest `SessionStart(compact)` |

Third finding against this report's assumptions:

3. **Compaction is not a rare event.** Paseo's model of one compaction per long session does not
   hold: with a squeezed window Codex compacted 6 times in 90 seconds, ~13s apart. The checkpoint
   write path has to be cheap and idempotent, and any status view has to tolerate many
   `started`/`completed` pairs under one `sessionId`.

Two findings that contradict this report's assumptions:

1. **No token counts on either CLI transport.** This report's §5 "usage after compact is new state"
   derives from Paseo's Agent SDK stream (`compact_boundary` metadata). Neither Claude's nor Codex's
   *hook* payload carries usage. Pattern 6 is therefore not portable to ALP; the plan drops
   `preTokens`/`postTokens`/`contextWindowUsedTokens` rather than shipping permanently-null fields.
2. **Neither runtime accepts context back from `PostCompact`.** Claude's `executePostCompactHooks`
   only turns hook output into a `userDisplayMessage`; Codex's `post-compact.command.output` schema
   has no `hookSpecificOutput`. `SessionStart(source="compact")` is the sole reinjection path, and it
   is present on both.

Also measured, affecting hook body: Claude `PreCompact` can *block* compaction and its non-blocked
stdout is fed into that compaction; Claude `PostCompact` stdout is echoed to the user. ALP's hook
must exit 0 with empty stdout on both events.
