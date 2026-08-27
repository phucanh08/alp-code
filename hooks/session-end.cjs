#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
function fail(reason) { process.stdout.write(JSON.stringify({ decision: "block", reason })); }
function stopFailed(reason) { process.stdout.write(JSON.stringify({ continue: false, stopReason: reason, systemMessage: reason })); }
async function main() {
  let payload = {};
  let bridge;
  const executionId = process.env.ALP_DELEGATION_EXECUTION_ID || "";
  try {
    payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
    bridge = require(path.join(__dirname, "..", "dist", "src", "hooks", "execution-bridge.js"));
    const output = bridge.parseAssistantOutput(payload.last_assistant_message ?? payload.output ?? payload.final_output ?? payload.result);
    const result = await bridge.finalizeExecution({ executionId, output });
    if (!result.ok) {
      const reason = `output validation failed (${result.status}): ${result.issues.join("; ")}${result.status === "failed" ? "; output repair budget exhausted" : ""}`;
      return result.status === "failed" ? stopFailed(reason) : fail(reason);
    }
    process.stdout.write(JSON.stringify({ systemMessage: `execution ${executionId} finalized` }));
  } catch (error) {
    const reason = `execution finalization failed closed: ${error.message}`;
    if (bridge && executionId) {
      try {
        const result = await bridge.finalizeExecution({ executionId, output: undefined });
        const detail = `${reason}; ${result.issues.join("; ")}${result.status === "failed" ? "; output repair budget exhausted" : ""}`;
        return result.status === "failed" ? stopFailed(detail) : fail(detail);
      } catch { /* fall through to bounded fail-closed response */ }
    }
    return payload.stop_hook_active ? stopFailed(reason) : fail(reason);
  }
}
main();
