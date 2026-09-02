#!/usr/bin/env node
"use strict";

// SessionStart hook: puts the role's identity into context before the agent's first turn.
//
// Speed is the whole reason this file exists. It reads exactly one pre-rendered Markdown
// file and writes it to stdout — no `dist/` load, no registry construction, no TypeScript
// runtime. The alternative (pointing the agent at `prompt.md` and telling it to read the
// file itself) costs a tool round-trip before any real work starts.
//
// Fail-open by design, unlike the policy hooks: if identity cannot be loaded, the session
// still starts, and the reason is surfaced as a warning rather than swallowed. A missing
// file means `alp identity sync` has not run in this checkout.

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
  const role = process.env.ALP_ROLE || "main";
  if (!ROLE_PATTERN.test(role)) throw new Error(`invalid role \`${role}\``);
  const file = path.join(repoRoot(), ".alp", "agents", `${role}.md`);
  emit(fs.readFileSync(file, "utf8"), null);
} catch (error) {
  emit("", `ALP identity not loaded: ${error.message}. Run \`alp identity sync\`.`);
}
