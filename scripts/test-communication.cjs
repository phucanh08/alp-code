#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ENTRYPOINT_CONTRACT, checkCommunicationTopology } = require("./lib/communication.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alp-code-communication-"));
try {
  write("AGENTS.md", "Phở is the default principal-facing role\n");
  write("identity/main/AGENTS.md", "Phở is main\n");
  write(`identity/search/AGENTS.md`, ENTRYPOINT_CONTRACT);
  write(`identity/search/CLAUDE.md`, ENTRYPOINT_CONTRACT);
  write(`identity/_template/AGENTS.md`, ENTRYPOINT_CONTRACT);
  write(`identity/_template/CLAUDE.md`, ENTRYPOINT_CONTRACT);
  write("identity/_template/loadout.yaml", "reports_to: main\n");

  const roles = ["main", "search"];
  const loadouts = { main: { reports_to: "principal" }, search: { reports_to: "main" } };
  assert.deepStrictEqual(checkCommunicationTopology(root, roles, (role) => loadouts[role]), []);

  loadouts.search.reports_to = "principal";
  assert(checkCommunicationTopology(root, roles, (role) => loadouts[role])
    .some((item) => item.tag === "COMMS-TOPOLOGY"));
  loadouts.search.reports_to = "main";

  fs.writeFileSync(path.join(root, "identity/search/AGENTS.md"), "missing contract\n");
  assert(checkCommunicationTopology(root, roles, (role) => loadouts[role])
    .some((item) => item.tag === "COMMS-CONTRACT"));

  console.log("OK               communication topology tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function write(relative, text) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
