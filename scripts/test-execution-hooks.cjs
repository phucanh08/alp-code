#!/usr/bin/env node
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "alp-execution-hooks-"));
try {
  const { agentRegistry } = require(path.join(repoRoot, "dist", "src", "agents", "registry.js"));
  const { createExecutionPolicy } = require(path.join(repoRoot, "dist", "src", "execution", "execution-policy.js"));
  const { WorkflowRunner } = require(path.join(repoRoot, "dist", "src", "workflow", "workflow-runner.js"));
  const executionId = "exec_process_hook";
  const directory = path.join(root, executionId);
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(directory, "runtime"));
  const promptFile = path.join(directory, "runtime", "prompt.md");
  fs.writeFileSync(promptFile, "task");
  const definition = agentRegistry.get("main");
  const policy = createExecutionPolicy({
    executionId,
    definition,
    workspace,
    workspaceMode: "workspace-write",
    createdAt: "2026-08-27T00:00:00.000Z",
  });
  const workflow = new WorkflowRunner().initialize(definition.workflow);
  fs.writeFileSync(path.join(directory, "policy.json"), JSON.stringify(policy), { mode: 0o600 });
  fs.writeFileSync(path.join(directory, "state.json"), JSON.stringify({
    executionId,
    status: "prepared",
    workflow,
    policyHash: policy.policyHash,
    createdAt: policy.createdAt,
  }), { mode: 0o600 });

  const env = {
    ...process.env,
    ALP_DELEGATION_EXECUTION_ID: executionId,
    ALP_EXECUTION_ROOT: root,
    ALP_MEMORY_ROOT: path.join(root, "memory"),
  };
  const preTool = spawnSync(process.execPath, [path.join(repoRoot, "hooks", "acl-guard.cjs")], {
    cwd: workspace,
    env,
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(workspace, "result.txt") }, cwd: workspace }),
    encoding: "utf8",
  });
  assert.strictEqual(preTool.status, 0, preTool.stderr);
  assert.strictEqual(JSON.parse(preTool.stdout).hookSpecificOutput.permissionDecision, "allow");

  const promptRead = spawnSync(process.execPath, [path.join(repoRoot, "hooks", "acl-guard.cjs")], {
    cwd: workspace,
    env,
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: promptFile }, cwd: workspace }),
    encoding: "utf8",
  });
  assert.strictEqual(JSON.parse(promptRead.stdout).hookSpecificOutput.permissionDecision, "allow");

  const stop = spawnSync(process.execPath, [path.join(repoRoot, "hooks", "session-end.cjs")], {
    cwd: workspace,
    env,
    input: JSON.stringify({
      hook_event_name: "Stop",
      last_assistant_message: JSON.stringify({ status: "completed", summary: "done", evidence: [], questions: [] }),
    }),
    encoding: "utf8",
  });
  assert.strictEqual(stop.status, 0, stop.stderr);
  assert.match(JSON.parse(stop.stdout).systemMessage, /finalized/);
  const finalState = JSON.parse(fs.readFileSync(path.join(directory, "state.json"), "utf8"));
  assert.strictEqual(finalState.status, "completed");
  assert.deepStrictEqual(finalState.output, { status: "completed", summary: "done", evidence: [], questions: [] });

  const repairExecutionId = "exec_process_hook_repair";
  const repairDirectory = path.join(root, repairExecutionId);
  fs.mkdirSync(repairDirectory, { recursive: true, mode: 0o700 });
  const repairDefinition = agentRegistry.get("search");
  const repairPolicy = createExecutionPolicy({
    executionId: repairExecutionId,
    definition: repairDefinition,
    workspace,
    workspaceMode: "read-only",
    createdAt: "2026-08-27T00:00:00.000Z",
  });
  fs.writeFileSync(path.join(repairDirectory, "policy.json"), JSON.stringify(repairPolicy), { mode: 0o600 });
  fs.writeFileSync(path.join(repairDirectory, "state.json"), JSON.stringify({
    executionId: repairExecutionId,
    status: "prepared",
    workflow: new WorkflowRunner().initialize(repairDefinition.workflow),
    policyHash: repairPolicy.policyHash,
    createdAt: repairPolicy.createdAt,
  }), { mode: 0o600 });
  const repairEnv = { ...env, ALP_DELEGATION_EXECUTION_ID: repairExecutionId };
  const firstInvalidStop = spawnSync(process.execPath, [path.join(repoRoot, "hooks", "session-end.cjs")], {
    cwd: workspace,
    env: repairEnv,
    input: JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "prose" }),
    encoding: "utf8",
  });
  assert.strictEqual(JSON.parse(firstInvalidStop.stdout).decision, "block");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(repairDirectory, "state.json"), "utf8")).status, "repairing");
  const secondInvalidStop = spawnSync(process.execPath, [path.join(repoRoot, "hooks", "session-end.cjs")], {
    cwd: workspace,
    env: repairEnv,
    input: JSON.stringify({ hook_event_name: "Stop", stop_hook_active: true, last_assistant_message: "still prose" }),
    encoding: "utf8",
  });
  const terminalStop = JSON.parse(secondInvalidStop.stdout);
  assert.strictEqual(terminalStop.continue, false);
  assert.match(terminalStop.stopReason, /repair budget exhausted|failed closed/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(repairDirectory, "state.json"), "utf8")).status, "failed");

  const denied = spawnSync(process.execPath, [path.join(repoRoot, "hooks", "acl-guard.cjs")], {
    cwd: workspace,
    env: { ...env, ALP_DELEGATION_EXECUTION_ID: "" },
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {}, cwd: workspace }),
    encoding: "utf8",
  });
  assert.strictEqual(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
  console.log("OK               execution hooks: compiled policy + workflow process bridge");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
