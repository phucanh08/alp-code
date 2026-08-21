const fs = require("fs");
const path = require("path");

const ENTRYPOINT_CONTRACT = "Kênh giao tiếp — chỉ qua main";

function checkCommunicationTopology(repoRoot, roles, loadLoadout) {
  const issues = [];
  const add = (tag, msg) => issues.push({ tag, msg });
  const exists = (relative) => fs.existsSync(path.join(repoRoot, relative));
  const contains = (relative, needle) =>
    exists(relative) && fs.readFileSync(path.join(repoRoot, relative), "utf8").includes(needle);
  const hasLine = (relative, expected) =>
    exists(relative) && fs.readFileSync(path.join(repoRoot, relative), "utf8")
      .split(/\r?\n/)
      .some((line) => line.trim() === expected);

  if (!exists("AGENTS.md")) add("COMMS-MISSING", "thiếu AGENTS.md ở repo root");
  if (!exists("identity/main/AGENTS.md")) add("COMMS-MISSING", "main thiếu AGENTS.md");

  for (const role of roles) {
    const expected = role === "main" ? "principal" : "main";
    const actual = loadLoadout(role)?.reports_to;
    if (actual !== expected)
      add("COMMS-TOPOLOGY", `${role} phải reports_to: ${expected}, hiện là ${actual || "rỗng"}`);

    if (role !== "main") {
      for (const file of [`identity/${role}/AGENTS.md`, `identity/${role}/CLAUDE.md`])
        if (!contains(file, ENTRYPOINT_CONTRACT))
          add("COMMS-CONTRACT", `${file} thiếu contract giao tiếp qua main`);
    }
  }

  for (const file of ["identity/_template/AGENTS.md", "identity/_template/CLAUDE.md"])
    if (!contains(file, ENTRYPOINT_CONTRACT))
      add("COMMS-CONTRACT", `${file} thiếu contract giao tiếp qua main`);
  if (!hasLine("identity/_template/loadout.yaml", "reports_to: main"))
    add("COMMS-TOPOLOGY", "template vai mới phải reports_to: main");

  return issues;
}

module.exports = { ENTRYPOINT_CONTRACT, checkCommunicationTopology };
