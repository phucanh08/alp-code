#!/usr/bin/env node
"use strict";

// Stop hook: records the execution's final answer and closes out its state file.
//
// This hook does NOT judge the answer. It used to parse the last assistant message as
// JSON and reply `{"decision":"block"}` when that failed, which forced every role —
// including the principal-facing one — to speak JSON instead of prose. Roles now return
// text, so the only job left here is bookkeeping: write the output into `state.json` so
// `run-main.ts` and `delegation-service.ts` can reconcile status afterwards.
//
// Fail-open by design. A bookkeeping error must never trap a finished session.

const fs = require("node:fs");
const path = require("node:path");

function note(message) { process.stdout.write(JSON.stringify({ systemMessage: message })); }

async function main() {
  const executionId = process.env.ALP_DELEGATION_EXECUTION_ID || "";
  try {
    const payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
    const bridge = require(path.join(__dirname, "..", "dist", "src", "hooks", "execution-bridge.js"));
    const output = payload.last_assistant_message ?? payload.output ?? payload.final_output ?? payload.result;
    const result = await bridge.finalizeExecution({ executionId, output });
    return note(result.ok
      ? `execution ${executionId} finalized`
      : `execution ${executionId} finalized with issues: ${result.issues.join("; ")}`);
  } catch (error) {
    return note(`execution ${executionId} could not be finalized: ${error.message}`);
  }
}

main();
