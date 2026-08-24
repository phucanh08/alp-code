#!/usr/bin/env node
// test-claude-hooks.cjs — khóa lỗi shell nuốt backslash trong path hook Windows.

const assert = require("assert");
const path = require("path");
const { spawnSync } = require("child_process");
const L = require("./lib/loadout.cjs");
const S = require("./lib/claude-settings.cjs");

const repoRoot = L.findRepoRoot(__dirname);
assert(repoRoot, "không tìm thấy repo root");

const generated = S.hooks(repoRoot);
const files = {
  SessionStart: "session-start.cjs",
  PreToolUse: "acl-guard.cjs",
  Stop: "session-end.cjs",
};

for (const [event, file] of Object.entries(files)) {
  const script = path.join(repoRoot, "hooks", file);
  const expected = process.platform === "win32"
    ? `node "${script.split(path.sep).join("/")}"`
    : "node '" + script.replace(/'/g, "'\\''") + "'";
  const command = generated[event][0].hooks[0].command;
  assert.strictEqual(command, expected, `${event}: lệnh hook quote sai`);
  if (process.platform === "win32")
    assert(!command.includes("\\"), `${event}: backslash Windows vẫn lọt vào shell`);
}

const session = spawnSync(generated.SessionStart[0].hooks[0].command, {
  shell: true,
  cwd: repoRoot,
  input: JSON.stringify({
    hook_event_name: "SessionStart",
    source: "startup",
    cwd: repoRoot,
  }),
  encoding: "utf8",
  env: { ...process.env, ALP_ROLE: "main", NODE_EXTRA_CA_CERTS: "" },
});
assert.strictEqual(session.status, 0, `SessionStart lỗi qua shell thật:\n${session.stderr}`);
assert.match(session.stdout, /\*\*Vai:\*\* main/, "SessionStart không nạp identity main");

console.log("OK       Claude hooks quote path đúng và SessionStart chạy được qua shell");
