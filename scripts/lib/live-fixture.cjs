"use strict";
// Phần phán của fixture live (tầng 4, vision §10.3): thuần, không chạy gì — để unit test
// khoá được cái runner sẽ kết luận từ `wait --json` và `git status`.

/**
 * @param {{ expected: { disposition: string, workspaceChanged: boolean } }} fixture
 * @param {{ status?: string, outcome?: { disposition?: string, reason?: string|null, evidenceRefs?: string[] } }} waited  kết quả `alp delegation wait --json`
 * @param {string} gitStatus  stdout của `git status --porcelain` trên thư mục project
 * @returns {{ ok: boolean, findings: string[] }}
 */
function judge(fixture, waited, gitStatus) {
  const findings = [];
  // `.claude/` trong project là state runtime (`.cc-writes/`, `session-state/`) Claude Code
  // tự tạo khi được launch với cwd ở đó — không phải worker viết, không phải bằng chứng.
  gitStatus = gitStatus.split(/\r?\n/).filter((line) => line.trim() !== "" && !/(^|\/)\.claude\//.test(line)).join("\n");
  const disposition = waited.outcome ? waited.outcome.disposition : undefined;
  if (disposition !== fixture.expected.disposition) {
    findings.push(`disposition: expected \`${fixture.expected.disposition}\`, got \`${disposition === undefined ? "(no outcome)" : disposition}\`` +
      (waited.outcome && waited.outcome.reason ? ` — reason: ${waited.outcome.reason}` : ""));
  }
  const changed = gitStatus.trim() !== "";
  if (changed !== fixture.expected.workspaceChanged) {
    findings.push(fixture.expected.workspaceChanged
      ? "workspace: expected a change, the project is clean"
      : `workspace: expected no change, the project has:\n${gitStatus.trimEnd()}`);
  }
  if (findings.length === 0 && (!waited.outcome || !Array.isArray(waited.outcome.evidenceRefs) || waited.outcome.evidenceRefs.length === 0)) {
    findings.push("evidence: the disposition is right but names no evidence — a Peer defends a refusal with what it saw");
  }
  return { ok: findings.length === 0, findings };
}

module.exports = { judge };
