#!/usr/bin/env node
"use strict";
// Tầng 4 (live) cho contract Peer — master plan 2c. Xem test/fixtures/live/wrong-premise/README.md.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { judge } = require("./lib/live-fixture.cjs");

const repoRoot = path.resolve(__dirname, "..");
const fixtureDir = path.join(repoRoot, "test", "fixtures", "live", "wrong-premise");
const fixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, "fixture.json"), "utf8"));

const argv = process.argv.slice(2);
const modeIndex = argv.indexOf("--mode");
const modeArgs = modeIndex === -1 ? [] : ["--mode", argv[modeIndex + 1]];

if (!process.env.ALP_DELEGATION_EXECUTION_ID) {
  console.error("ERROR     `alp delegate` needs a parent execution: run this from inside an ALP session (ask `main` to run it), not from a bare terminal");
  process.exit(2);
}

// `alp` on PATH is `scripts/alp.cjs` → `dist/`; a `dist/` older than `src/` runs the
// previous worker prompt and, before 2a, records no outcome at all — the first live run
// judged a build from the day before and learned nothing about this branch.
const distEntry = path.join(repoRoot, "dist", "src", "cli", "alp.js");
const builtAt = fs.existsSync(distEntry) ? fs.statSync(distEntry).mtimeMs : 0;
const newest = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((max, entry) => {
  const full = path.join(dir, entry.name);
  return Math.max(max, entry.isDirectory() ? newest(full) : fs.statSync(full).mtimeMs);
}, 0);
if (builtAt < newest(path.join(repoRoot, "src"))) {
  console.error("ERROR     dist/ is older than src/: run `npm run build` (from a bare terminal — `main` cannot write the workspace), then rerun");
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

// No copy: `main` — the seat that runs this — cannot write its workspace (not even a temp
// directory), and `alp delegate` only launches a child inside that workspace, so the fixture
// runs IN PLACE at `test/fixtures/live/wrong-premise/project`. The judge reads `git status`
// of that directory in this repo; a worker that "fixes" the non-bug leaves a diff there, and
// the restore command is printed on failure. The tree under it must be clean to start with.
const project = path.join(fixtureDir, "project");
const relative = path.relative(repoRoot, project);
const before = git(repoRoot, "status", "--porcelain", "--", relative);
if (before.trim() !== "") {
  console.error(`ERROR     ${relative} is not clean; restore it first:\n${before}          git checkout -- ${relative} && git clean -fd ${relative}`);
  process.exit(2);
}

const delegateArgs = [
  "delegate", fixture.role, ...modeArgs, "--project", project, "--background",
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
const verdict = judge(fixture, result, git(repoRoot, "status", "--porcelain", "--", relative));
console.log(`LIVE      status ${result.status} · disposition ${result.outcome ? result.outcome.disposition : "(none)"}` +
  (result.outcome && result.outcome.reason ? ` · reason: ${result.outcome.reason}` : ""));
if (verdict.ok) {
  console.log(`OK        wrong-premise: worker answered \`${fixture.expected.disposition}\` and left the workspace alone`);
} else {
  for (const finding of verdict.findings) console.error(`FAIL      ${finding}`);
  console.error(`          inspect what the worker did with \`git diff -- ${relative}\`, then restore: git checkout -- ${relative} && git clean -fd ${relative}`);
  process.exitCode = 1;
}
