#!/usr/bin/env node
"use strict";
// Tầng 4 (live) cho contract Peer — master plan 2c. Xem test/fixtures/live/wrong-premise/README.md.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { judge } = require("./lib/live-fixture.cjs");

const repoRoot = path.resolve(__dirname, "..");
const fixtureDir = path.join(repoRoot, "test", "fixtures", "live", "wrong-premise");
const fixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, "fixture.json"), "utf8"));

const argv = process.argv.slice(2);
const modeIndex = argv.indexOf("--mode");
const modeArgs = modeIndex === -1 ? [] : ["--mode", argv[modeIndex + 1]];
const keep = argv.includes("--keep");

if (!process.env.ALP_DELEGATION_EXECUTION_ID) {
  console.error("ERROR     `alp delegate` needs a parent execution: run this from inside an ALP session (ask `main` to run it), not from a bare terminal");
  process.exit(2);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}
function git(cwd, ...args) {
  const result = run("git", ["-c", "user.name=live-fixture", "-c", "user.email=live-fixture@example.invalid", ...args], { cwd });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

const copy = fs.mkdtempSync(path.join(os.tmpdir(), "alp-live-wrong-premise-"));
if (!keep) process.on("exit", () => fs.rmSync(copy, { recursive: true, force: true }));
fs.cpSync(path.join(fixtureDir, "project"), copy, { recursive: true });
git(copy, "init", "-q");
git(copy, "add", ".");
git(copy, "commit", "-q", "-m", "baseline");

const delegateArgs = [
  "delegate", fixture.role, ...modeArgs, "--project", copy, "--background",
  "--objective", fixture.objective, "--verification", fixture.verification,
  ...fixture.writeScope.flatMap((entry) => ["--write-scope", entry]),
  "--require-evidence", "change",
  "--", fixture.task,
];
console.log(`LIVE      alp ${delegateArgs.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`);
const spawned = run("alp", delegateArgs);
if (spawned.status !== 0) {
  console.error(`ERROR     alp delegate exited ${spawned.status}\n${spawned.stdout}${spawned.stderr}`);
  process.exit(1);
}
const executionId = (spawned.stdout.match(/exec_[A-Za-z0-9_]+/) || [])[0];
if (!executionId) {
  console.error(`ERROR     no execution id in:\n${spawned.stdout}`);
  process.exit(1);
}
console.log(`LIVE      waiting on ${executionId}`);
const waited = run("alp", ["delegation", "wait", executionId, "--json"]);
if (waited.status !== 0) {
  console.error(`ERROR     alp delegation wait exited ${waited.status}\n${waited.stdout}${waited.stderr}`);
  process.exit(1);
}
const result = JSON.parse(waited.stdout);
const verdict = judge(fixture, result, git(copy, "status", "--porcelain"));
console.log(`LIVE      status ${result.status} · disposition ${result.outcome ? result.outcome.disposition : "(none)"}` +
  (result.outcome && result.outcome.reason ? ` · reason: ${result.outcome.reason}` : ""));
if (verdict.ok) {
  console.log(`OK        wrong-premise: worker answered \`${fixture.expected.disposition}\` and left the workspace alone${keep ? ` (copy kept at ${copy})` : ""}`);
} else {
  for (const finding of verdict.findings) console.error(`FAIL      ${finding}`);
  if (keep) console.error(`          copy kept at ${copy}`);
  process.exitCode = 1;
}
