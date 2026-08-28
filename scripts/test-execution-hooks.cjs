#!/usr/bin/env node
"use strict";

// Process-level check of the two runtime hooks, exercised the way a runtime invokes them:
// a real child process, real stdin payload, real `dist/` load. The in-process vitest suite
// covers the bridge functions; this covers the wiring around them.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "alp-execution-hooks-"));

function runHook(script, options) {
  return spawnSync(process.execPath, [path.join(repoRoot, "hooks", script)], {
    encoding: "utf8",
    ...options,
  });
}

try {
  const { agentRegistry } = require(path.join(repoRoot, "dist", "src", "agents", "registry.js"));
  const { createExecutionPolicy } = require(path.join(repoRoot, "dist", "src", "execution", "execution-policy.js"));
  const { WorkflowRunner } = require(path.join(repoRoot, "dist", "src", "workflow", "workflow-runner.js"));

  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });

  function seedExecution(executionId, role, workspaceMode) {
    const directory = path.join(root, executionId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const definition = agentRegistry.get(role);
    const policy = createExecutionPolicy({
      executionId,
      definition,
      workspace,
      workspaceMode,
      createdAt: "2026-08-27T00:00:00.000Z",
    });
    fs.writeFileSync(path.join(directory, "policy.json"), JSON.stringify(policy), { mode: 0o600 });
    fs.writeFileSync(path.join(directory, "state.json"), JSON.stringify({
      executionId,
      status: "prepared",
      workflow: new WorkflowRunner().initialize(definition.workflow),
      policyHash: policy.policyHash,
      createdAt: policy.createdAt,
    }), { mode: 0o600 });
    return directory;
  }

  const baseEnv = {
    ...process.env,
    ALP_EXECUTION_ROOT: root,
    ALP_MEMORY_ROOT: path.join(root, "memory"),
  };

  // --- SessionStart: identity reaches the agent before its first turn -----------------
  const agentsDirectory = path.join(root, ".alp", "agents");
  fs.mkdirSync(agentsDirectory, { recursive: true });
  fs.writeFileSync(path.join(agentsDirectory, "search.md"), "# Search\n\nStatic identity.\n");

  const boot = runHook("session-boot.cjs", {
    cwd: workspace,
    env: { ...baseEnv, ALP_REPO_ROOT: root, ALP_ROLE: "search" },
    input: JSON.stringify({ hook_event_name: "SessionStart" }),
  });
  assert.strictEqual(boot.status, 0, boot.stderr);
  const bootOutput = JSON.parse(boot.stdout);
  assert.strictEqual(bootOutput.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(bootOutput.hookSpecificOutput.additionalContext, /Static identity/);
  assert.strictEqual(bootOutput.systemMessage, undefined);

  // Fail-open: a missing identity document warns, it does not abort the session.
  const bootMissing = runHook("session-boot.cjs", {
    cwd: workspace,
    env: { ...baseEnv, ALP_REPO_ROOT: root, ALP_ROLE: "oracle" },
    input: JSON.stringify({ hook_event_name: "SessionStart" }),
  });
  assert.strictEqual(bootMissing.status, 0, bootMissing.stderr);
  const missingOutput = JSON.parse(bootMissing.stdout);
  assert.strictEqual(missingOutput.hookSpecificOutput.additionalContext, "");
  assert.match(missingOutput.systemMessage, /identity sync/);

  // --- Stop: a prose answer is recorded, never blocked -------------------------------
  const proseId = "exec_process_hook";
  const proseDirectory = seedExecution(proseId, "main", "workspace-write");
  const prose = "Completed — patched src/index.ts and ran `npm test`: 12 passed.";
  const stop = runHook("session-end.cjs", {
    cwd: workspace,
    env: { ...baseEnv, ALP_DELEGATION_EXECUTION_ID: proseId },
    input: JSON.stringify({ hook_event_name: "Stop", last_assistant_message: prose }),
  });
  assert.strictEqual(stop.status, 0, stop.stderr);
  const stopOutput = JSON.parse(stop.stdout);
  assert.match(stopOutput.systemMessage, /finalized/);
  // The regression this guards: prose used to come back as `{"decision":"block"}`.
  assert.strictEqual(stopOutput.decision, undefined);
  assert.strictEqual(stopOutput.continue, undefined);
  const finalState = JSON.parse(fs.readFileSync(path.join(proseDirectory, "state.json"), "utf8"));
  assert.strictEqual(finalState.status, "completed");
  assert.strictEqual(finalState.output, prose);

  // --- Stop: an absent answer is still recoverable, then terminal --------------------
  const emptyId = "exec_process_hook_repair";
  const emptyDirectory = seedExecution(emptyId, "search", "read-only");
  const emptyEnv = { ...baseEnv, ALP_DELEGATION_EXECUTION_ID: emptyId };
  const firstEmpty = runHook("session-end.cjs", {
    cwd: workspace,
    env: emptyEnv,
    input: JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "" }),
  });
  assert.strictEqual(firstEmpty.status, 0, firstEmpty.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(emptyDirectory, "state.json"), "utf8")).status, "repairing");
  runHook("session-end.cjs", {
    cwd: workspace,
    env: emptyEnv,
    input: JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "" }),
  });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(emptyDirectory, "state.json"), "utf8")).status, "failed");

  // --- Stop: an unknown execution is reported, not fatal -----------------------------
  const orphan = runHook("session-end.cjs", {
    cwd: workspace,
    env: { ...baseEnv, ALP_DELEGATION_EXECUTION_ID: "" },
    input: JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "prose" }),
  });
  assert.strictEqual(orphan.status, 0, orphan.stderr);
  assert.match(JSON.parse(orphan.stdout).systemMessage, /could not be finalized/);

  console.log("OK               execution hooks: SessionStart identity + Stop prose finalization");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
