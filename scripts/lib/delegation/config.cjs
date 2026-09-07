const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const P = require("../install-paths.cjs");

/**
 * Cả `core/` bên cạnh file này từng giữ một cây lỗi delegation cho backend CJS. Backend đó
 * đã gỡ ngày 2026-09-03 và mã CJS còn lại chỉ ném đúng một loại lỗi, nên nó ở ngay đây.
 */
class InvalidConfiguration extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidConfiguration";
    this.code = "InvalidConfiguration";
  }
}

function parseConfig(text) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  for (const raw of String(text).split(/\r?\n/)) {
    const clean = raw.replace(/^\s*#.*$/, "").replace(/\s+#.*$/, "");
    if (!clean.trim()) continue;
    const match = clean.match(/^(\s*)([a-zA-Z_][\w-]*):(?:\s*(.*))?$/);
    if (!match) throw new InvalidConfiguration(`Dòng config không hợp lệ: ${raw.trim()}`);
    const indent = match[1].length;
    while (stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1).value;
    const key = match[2];
    const source = (match[3] || "").trim();
    if (!source) {
      parent[key] = {};
      stack.push({ indent, value: parent[key] });
    } else if (/^(?:true|false)$/i.test(source)) parent[key] = source.toLowerCase() === "true";
    else parent[key] = source.replace(/^(["'])(.*)\1$/, "$2");
  }
  return root;
}

/**
 * Chỉ còn đúng một thứ để cấu hình: state directory.
 *
 * Trước 2026-09-03 hàm này chọn backend giữa `local` và `paseo`, kèm fallback và một
 * lựa chọn ghi đè lưu trong `$stateDir/backend`. Paseo đã gỡ, nên mọi nhánh chọn lựa
 * đó không còn gì để chọn — giữ lại chỉ là chỗ cho cấu hình nói dối về thứ đang chạy.
 */
function loadDelegationConfig(repoRoot, env = process.env) {
  const file = env.ALP_CONFIG || path.join(repoRoot, "alp.config.yaml");
  let root = {};
  if (fs.existsSync(file)) root = parseConfig(fs.readFileSync(file, "utf8"));
  const raw = root.delegation || {};
  const stateDir = env.ALP_DELEGATION_STATE_DIR || raw.state_dir || defaultStateDir(repoRoot, env);
  return { file, stateDir: path.resolve(stateDir) };
}

/**
 * Băm theo đường dẫn thư mục cài để hai clone không giẫm lên state của nhau. Đúng khi thư mục
 * cài là một clone cố định — và chỉ khi đó. Từ v0.9.0 bản cài là artifact thay được, có thể
 * nằm ở `versions/<tag>` khác nhau mỗi lần update, nên băm nó nghĩa là mất state mỗi bản.
 */
function defaultStateDir(repoRoot, env) {
  const home = env.HOME || os.homedir();
  return P.detectChannel(repoRoot) === "dev"
    ? legacyStateDir(repoRoot, env)
    : path.join(home, ".alp", "delegation", "installed");
}

/** Đường dẫn state theo luật cũ (băm repo root) — cần để di trú bản cài trước v0.9.0. */
function legacyStateDir(repoRoot, env) {
  const home = env.HOME || os.homedir();
  const repoKey = crypto.createHash("sha256").update(path.resolve(repoRoot)).digest("hex").slice(0, 12);
  return path.join(home, ".alp", "delegation", repoKey);
}

module.exports = {
  loadDelegationConfig,
  defaultStateDir,
  legacyStateDir,
  parseConfig,
};
