#!/usr/bin/env node
"use strict";

// SessionStart hook: puts the session context into the model's view before turn 1, and — for
// every `source` including `"compact"` — the continuity checkpoint right after it.
//
// This is the *only* channel ALP identity and continuity travel on, for both runtimes. Claude
// Code and Codex CLI both turn `additionalContext` into a developer-role message ahead of the
// first user turn, which is exactly the guarantee an interactive session needs: fully briefed,
// zero turns spent. Measured 2026-09-04: `SessionStart(source="compact")` is the one point both
// runtimes agree on for reinjection after native compaction — Claude fires it *during*
// compaction, Codex at the start of the next turn — so this hook runs unchanged for every
// `source` rather than branching on it.
//
// Two identity sources, in priority order:
//   1. `ALP_SESSION_CONTEXT` — this execution's own file, written by the runtime adapter.
//      It carries identity plus the invariants, policy context and workspace grant that
//      only ALP knows. Every session launched through `alp` gets this.
//   2. `.alp/agents/<role>.md` — the static role document, for the native path where the
//      principal ran `claude`/`codex` directly and no adapter was involved.
//
// One continuity source, appended after whichever identity source loaded: `ALP_CONTINUITY_
// CONTEXT`, the pre-rendered `continuity.md` (plan §9). It is optional in a way identity is
// not — a fresh execution with no pins yet renders to an empty string, and `alp` launches
// with the bridge flag off never carry an objective worth mentioning either — so a missing or
// empty file is quiet, not a warning. Only a continuity file that exists but cannot be trusted
// (unreadable, or over the same 24 KiB bound the renderer itself enforces) gets one, because
// that state means something ALP wrote is no longer being read back correctly.
//
// Speed is why both sources are pre-rendered files: no `dist/` load, no registry
// construction, no TypeScript runtime, no Zod. Pointing the agent at a file and asking it to
// Read would cost a tool round-trip before any real work starts.
//
// Fail-open by design, unlike the policy hooks: if context cannot be loaded, the session
// still starts and the reason surfaces as a warning rather than being swallowed. Managed
// launches fail closed earlier and elsewhere — the adapter writes these files before it
// spawns anything, so an unwritable one aborts `prepare()` and no process ever starts.

const fs = require("node:fs");
const path = require("node:path");

const ROLE_PATTERN = /^[a-z][a-z0-9-]*$/;
// Same bound as `renderContinuity`'s `MAX_RENDERED_BYTES` (plan §9) — there is only one
// injection limit, so a file over it did not come out of that renderer and is not trusted.
const MAX_CONTINUITY_BYTES = 24 * 1024;

function emit(context, warning) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
    ...(warning ? { systemMessage: `⚠️  ${warning}` } : {}),
  }));
}

function repoRoot() {
  return process.env.ALP_REPO_ROOT || path.join(__dirname, "..");
}

function loadSessionContext() {
  const sessionContext = process.env.ALP_SESSION_CONTEXT;
  if (sessionContext) return fs.readFileSync(sessionContext, "utf8");
  const role = process.env.ALP_ROLE || "main";
  if (!ROLE_PATTERN.test(role)) throw new Error(`invalid role \`${role}\``);
  const file = path.join(repoRoot(), ".alp", "agents", `${role}.md`);
  return fs.readFileSync(file, "utf8");
}

/**
 * Best-effort load of `continuity.md`. Never throws: a problem here must not cost the
 * session its identity, which is why it is read after — and independently of —
 * `loadSessionContext()` rather than folded into the same try/catch.
 */
function loadContinuity() {
  const file = process.env.ALP_CONTINUITY_CONTEXT;
  if (!file) return { text: "", warning: null };
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch (error) {
    // Missing is the common case — a bridge-off launch, or an execution from before this
    // feature — and not worth a warning. Anything else (a directory, a permissions error)
    // means the path is wrong in a way worth surfacing.
    return { text: "", warning: error.code === "ENOENT" ? null : `ALP continuity not loaded: ${error.message}` };
  }
  if (content.trim().length === 0) return { text: "", warning: null };
  if (Buffer.byteLength(content, "utf8") > MAX_CONTINUITY_BYTES) {
    return { text: "", warning: "ALP continuity exceeds its injection bound and was skipped" };
  }
  return { text: content, warning: null };
}

try {
  const sessionContext = loadSessionContext();
  const continuity = loadContinuity();
  const context = continuity.text.length > 0 ? `${sessionContext}\n\n${continuity.text}` : sessionContext;
  emit(context, continuity.warning);
} catch (error) {
  emit("", `ALP identity not loaded: ${error.message}. Run \`alp identity sync\`.`);
}
