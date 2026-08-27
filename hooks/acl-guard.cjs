#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
function deny(reason) { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })); }
async function main() {
  try {
    const payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
    const bridge = require(path.join(__dirname, "..", "dist", "src", "hooks", "execution-bridge.js"));
    const result = await bridge.authorizeHookTool({ executionId: process.env.ALP_DELEGATION_EXECUTION_ID || "", tool: payload.tool_name || "", input: payload.tool_input || {}, cwd: payload.cwd || process.cwd() });
    if (!result.allowed) return deny(`${result.code}: ${result.reason}`);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }));
  } catch (error) { deny(`INVALID_EXECUTION: ${error.message}`); }
}
main();
