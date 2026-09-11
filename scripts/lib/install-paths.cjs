// install-paths.cjs — một chỗ duy nhất trả lời "alp-code để thứ gì ở đâu".
//
// VÌ SAO TỒN TẠI: từ v0.9.0 thư mục cài là một ARTIFACT DÙNG MỘT LẦN. `npm i -g alp-code`
// xoá sạch package dir cũ rồi giải nén bản mới; installer tarball giải nén vào
// `versions/<tag>` rồi trỏ lại symlink `current`. Bất cứ thứ gì của người dùng nằm trong đó
// đều biến mất ở lần update kế tiếp — nên KHÔNG có gì của người dùng được nằm trong đó nữa.
//
// Ranh giới:
//   · thư mục cài  — code đã build, hooks, skills, scaffold. Chỉ đọc, thay được bất cứ lúc nào.
//   · `~/.alp`     — memory, identity docs, execution/delegation state, preferences. Không ai
//                    thay hộ, không ai xoá hộ.
//
// Đây đúng là mô hình `npm i -g @anthropic-ai/claude-code` + `~/.claude` mà Claude Code và
// Codex CLI dùng, và là lý do cả hai bỏ được bước build ở máy người dùng.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

/** Thư mục cài mặc định của channel tarball — cũng là chỗ các bản < v0.9.0 clone về. */
const LEGACY_INSTALL_HOME = ".alp-code";

function homeDir(env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (!home) throw new Error("không xác định được HOME/USERPROFILE");
  return home;
}

/** `~/.alp` — gốc của mọi state cục bộ. `ALP_STATE_HOME` để test và cài song song. */
function stateHome(env = process.env) {
  return env.ALP_STATE_HOME ? path.resolve(env.ALP_STATE_HOME) : path.join(homeDir(env), ".alp");
}

/**
 * Gốc memory. `ALP_MEMORY_ROOT` vẫn thắng — doctor, adapter và test đã dựa vào nó từ trước,
 * và đó là đường duy nhất để chạy một ALP cô lập hoàn toàn.
 */
function memoryRoot(env = process.env) {
  return env.ALP_MEMORY_ROOT ? path.resolve(env.ALP_MEMORY_ROOT) : path.join(stateHome(env), "memory");
}

/** `~/.alp/agents/<role>.md` — cache identity phẳng cho SessionStart hook. */
function agentsDir(env = process.env) {
  return path.join(stateHome(env), "agents");
}

/** `~/.alp/hooks/` — forwarder có đường dẫn ỔN ĐỊNH; xem `hookForwarderPath`. */
function hooksDir(env = process.env) {
  return path.join(stateHome(env), "hooks");
}

function executionsDir(env = process.env) {
  return path.join(stateHome(env), "executions");
}

/** `~/.alp/execution-graphs/` — quyền lực logic của mỗi cây execution, một file mỗi cây. */
function executionGraphsDir(env = process.env) {
  return path.join(stateHome(env), "execution-graphs");
}

/**
 * Đường dẫn hook mà `alp init` ghi vào `<project>/.claude/settings.local.json`.
 *
 * KHÔNG BAO GIỜ trỏ thẳng vào thư mục cài. Cấu hình đó nằm trong project của người dùng và
 * sống lâu hơn mọi bản cài: đổi channel (tarball → npm), gỡ rồi cài lại chỗ khác, hay chỉ là
 * lên version với tarball `versions/<tag>` mới — tất cả đều làm một đường dẫn tuyệt đối tới
 * thư mục cài chết câm, và người dùng chỉ thấy phiên `claude` mất identity mà không rõ vì sao.
 */
function hookForwarderPath(name, env = process.env) {
  return path.join(hooksDir(env), `${name}.cjs`);
}

/** Bản ghi bản cài hiện hành. Forwarder đọc file này để tìm thư mục cài. */
function installRecordPath(env = process.env) {
  return path.join(stateHome(env), "install.json");
}

function readInstallRecord(env = process.env) {
  try {
    const parsed = JSON.parse(fs.readFileSync(installRecordPath(env), "utf8"));
    return typeof parsed?.root === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function writeInstallRecord(record, env = process.env) {
  const file = installRecordPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Channel của một thư mục cài, suy ra từ CHÍNH nó chứ không từ marker ghi lúc đóng gói:
 * cùng một cây file được `npm publish` và được nén vào tarball, nên nội dung không phân biệt
 * được hai bản cài — chỉ vị trí mới phân biệt được.
 *
 *   dev      — có `.git` và `src/`: bản clone của người phát triển, vẫn build tại chỗ.
 *   npm      — nằm dưới một `node_modules/`: npm sở hữu thư mục này.
 *   tarball  — còn lại: artifact giải nén, thường là `~/.alp-code/versions/<tag>`.
 */
function detectChannel(root) {
  const resolved = path.resolve(root);
  if (fs.existsSync(path.join(resolved, ".git")) && fs.existsSync(path.join(resolved, "src")))
    return "dev";
  if (resolved.split(path.sep).includes("node_modules")) return "npm";
  return "tarball";
}

/** Gốc cài mặc định cho channel tarball: `~/.alp-code`, với `current` trỏ vào version đang dùng. */
function tarballHome(env = process.env) {
  return env.ALP_HOME ? path.resolve(env.ALP_HOME) : path.join(homeDir(env), LEGACY_INSTALL_HOME);
}

function tarballCurrentLink(env = process.env) {
  return path.join(tarballHome(env), "current");
}

function tarballVersionsDir(env = process.env) {
  return path.join(tarballHome(env), "versions");
}

/**
 * Những chỗ memory có thể còn nằm lại từ bản < v0.9.0, theo thứ tự ưu tiên di trú.
 * `root` là thư mục cài hiện tại; bản cũ thì chính nó là repo clone chứa `memory/`.
 */
function legacyMemoryRoots(root, env = process.env) {
  const candidates = [
    path.join(path.resolve(root), "memory"),
    path.join(tarballHome(env), "memory"),
    path.join(homeDir(env), LEGACY_INSTALL_HOME, "memory"),
  ];
  const previous = readInstallRecord(env);
  if (previous?.root) candidates.push(path.join(previous.root, "memory"));
  return [...new Set(candidates)];
}

module.exports = {
  LEGACY_INSTALL_HOME,
  stateHome,
  memoryRoot,
  agentsDir,
  hooksDir,
  executionsDir,
  executionGraphsDir,
  hookForwarderPath,
  installRecordPath,
  readInstallRecord,
  writeInstallRecord,
  detectChannel,
  tarballHome,
  tarballCurrentLink,
  tarballVersionsDir,
  legacyMemoryRoots,
};
