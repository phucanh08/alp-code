#!/usr/bin/env node
"use strict";

// SessionStart hook: puts the session context into the model's view before turn 1.
//
// This is the *only* channel ALP identity travels on, for both runtimes. Claude Code and
// Codex CLI (measured on 0.149.0) both turn `additionalContext` into a developer-role
// message ahead of the first user turn, which is exactly the guarantee an interactive
// session needs: fully briefed, zero turns spent.
//
// Two sources, in priority order:
//   1. `ALP_SESSION_CONTEXT` — this execution's own file, written by the runtime adapter.
//      It carries identity plus the invariants, policy context and workspace grant that
//      only ALP knows. Every session launched through `alp` gets this.
//   2. `.alp/agents/<role>.md` — the static role document, for the native path where the
//      principal ran `claude`/`codex` directly and no adapter was involved.
//
// Speed is why it reads a pre-rendered file: no `dist/` load, no registry construction, no
// TypeScript runtime. Pointing the agent at the file and asking it to Read would cost a
// tool round-trip before any real work starts.
//
// Fail-open by design, unlike the policy hooks: if context cannot be loaded, the session
// still starts and the reason surfaces as a warning rather than being swallowed. Managed
// launches fail closed earlier and elsewhere — the adapter writes this file before it
// spawns anything, so an unwritable file aborts `prepare()` and no process ever starts.

const fs = require("node:fs");
const path = require("node:path");

const ROLE_PATTERN = /^[a-z][a-z0-9-]*$/;

function emit(context, warning) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
    ...(warning ? { systemMessage: `⚠️  ${warning}` } : {}),
  }));
}

function repoRoot() {
  return process.env.ALP_REPO_ROOT || path.join(__dirname, "..");
}

try {
  const sessionContext = process.env.ALP_SESSION_CONTEXT;
  if (sessionContext) {
    emit(fs.readFileSync(sessionContext, "utf8"), null);
  } else {
    const role = process.env.ALP_ROLE || "main";
    if (!ROLE_PATTERN.test(role)) throw new Error(`invalid role \`${role}\``);
    const file = path.join(repoRoot(), ".alp", "agents", `${role}.md`);
    emit(fs.readFileSync(file, "utf8"), null);
  }
} catch (error) {
  emit("", `ALP identity not loaded: ${error.message}. Run \`alp identity sync\`.`);
}
