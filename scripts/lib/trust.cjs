// trust.cjs — đánh dấu một thư mục là "trusted" cho Claude Code và cho Codex.
//
// BẪY 3 của plan alp-init: workspace chưa trust thì
//   - Claude Code BỎ QUA toàn bộ `permissions.allow` + `additionalDirectories`, và pane mới
//     dừng ở dialog "Is this a project you trust?" — HOOK KHÔNG CHẠY cho tới khi trả lời.
//   - Codex bỏ qua hook của config cấp project.
// Cả hai hỏng theo kiểu CÂM: không lỗi, không cảnh báo, agent chỉ đơn giản không có
// danh tính. Vì vậy mọi lệnh sinh config đều phải trust ngay trong cùng lượt chạy.
//
// macOS: /tmp là symlink tới /private/tmp và Claude Code dùng CẢ HAI dạng path làm key.
// Vì vậy luôn ghi cả path thường lẫn realpath.

const fs = require("fs");
const path = require("path");
const P = require("./codex-profile.cjs");

/** Cả path thường lẫn realpath — hai key mà runtime có thể dùng cho cùng thư mục. */
function pathVariants(dir) {
  const abs = path.resolve(dir);
  const out = new Set([abs]);
  try { out.add(fs.realpathSync(abs)); } catch {}
  return [...out];
}

/** File state sống của Claude Code. */
const claudeConfigPath = (env = process.env) =>
  path.join(env.HOME || require("os").homedir(), ".claude.json");

/**
 * Trust một hoặc nhiều thư mục trong `~/.claude.json`.
 * Trả về mảng key đã thêm (rỗng = đã trust từ trước).
 */
function trustClaude(dirs, env = process.env) {
  const cfgPath = claudeConfigPath(env);
  let cfg = {};
  if (fs.existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    } catch (e) {
      throw new Error(`${cfgPath} không parse được: ${e.message}`);
    }
  }
  // Máy mới chưa chạy Claude Code vẫn phải trust được. Claude Code chấp nhận object
  // tối thiểu này và bổ sung các key khác khi khởi động lần đầu.
  cfg.projects = cfg.projects || {};

  const added = [];
  for (const dir of dirs) {
    for (const key of pathVariants(dir)) {
      if (cfg.projects[key]?.hasTrustDialogAccepted) continue;
      cfg.projects[key] = { ...cfg.projects[key], hasTrustDialogAccepted: true };
      added.push(key);
    }
  }
  if (added.length) writeAtomic(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  return added;
}

/**
 * Trust trong `$CODEX_HOME/config.toml` bằng khối `[projects."<path>"]`.
 *
 * Sửa TOML của người dùng bằng regex là chấp nhận được ở đây vì phạm vi hẹp: chỉ thêm
 * hoặc sửa đúng khối `[projects."<path>"]` của mình, không đụng phần còn lại. Không kéo
 * thư viện TOML về chỉ để ghi hai dòng.
 */
function trustCodex(dirs, env = process.env) {
  const file = path.join(P.codexHome(env), "config.toml");
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const added = [];

  for (const dir of dirs) {
    for (const key of pathVariants(dir)) {
      const header = `[projects.${tomlKey(key)}]`;
      const block = blockRange(text, header);
      if (block) {
        // `[ \t]*`, KHÔNG phải `\s*`: `\s` nuốt cả `\n`, nên lần trust thứ hai sẽ ăn mất
        // dòng trống sau header và dán `trust_level` dính vào `[projects."x"]` — TOML hỏng,
        // Codex bỏ qua trust, hook chết câm. Đúng loại lỗi chỉ lộ ra ở lần chạy THỨ HAI.
        if (/^[ \t]*trust_level[ \t]*=/m.test(block.body)) {
          const fixed = block.body.replace(/^[ \t]*trust_level[ \t]*=.*$/m, 'trust_level = "trusted"');
          if (fixed === block.body) continue;
          text = text.slice(0, block.start) + fixed + text.slice(block.end);
        } else {
          text = text.slice(0, block.start) + block.body.trimEnd() + '\ntrust_level = "trusted"\n' + text.slice(block.end);
        }
      } else {
        text = (text ? text.trimEnd() + "\n\n" : "") + `${header}\ntrust_level = "trusted"\n`;
      }
      added.push(key);
    }
  }
  if (added.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, text);
  }
  return added;
}

/** Vị trí thân của một table TOML, tính từ sau dòng header tới header kế tiếp. */
function blockRange(text, header) {
  const headerStart = text.indexOf(header);
  if (headerStart < 0) return null;
  const start = headerStart + header.length;
  const rest = text.slice(start);
  const next = rest.search(/^\s*\[/m);
  const end = next < 0 ? text.length : start + next;
  return { headerStart, start, end, body: text.slice(start, end) };
}

/** Key của bảng TOML: luôn quote, escape backslash (Windows) rồi nháy kép. */
function tomlKey(p) {
  return '"' + p.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * Ghi qua file tạm rồi rename. `~/.claude.json` và `~/.codex/config.toml` là state sống
 * của runtime — ghi dở dang là hỏng cấu hình của MỌI phiên đang mở, không riêng phiên này.
 */
function writeAtomic(file, body) {
  const tmp = file + ".alp-code.tmp";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

module.exports = { trustClaude, trustCodex, pathVariants, claudeConfigPath };
