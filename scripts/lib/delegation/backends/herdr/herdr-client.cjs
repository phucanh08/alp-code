// Herdr client — toàn bộ terminology pane/fleet bị giữ trong adapter này.
//
// VÌ SAO CÓ FILE NÀY: bốn thứ dưới đây model làm sai gần như mỗi lần, và mỗi cái đều
// hỏng theo kiểu IM LẶNG (exit 0, không cảnh báo) nên không tự lộ ra:
//
//   1. `agent start` cần pane ĐÃ Ở DẤU NHẮC SHELL. Gọi ngay sau `pane split` thì dính
//      `agent_pane_busy`. Ở đây chờ hai lớp: hỏi `pane process-info` tới khi
//      `foreground_process_group_id == shell_pid`, RỒI thử lại chính `agent start` khi
//      nó vẫn kêu bận — điều kiện đủ chỉ herdr biết, nên hỏi thẳng nó. Không `sleep` mù.
//   2. `--seq` phải TĂNG NGHIÊM NGẶT. Seq cũ hoặc bằng bị bỏ qua im lặng, exit 0.
//      Ở đây seq là `Date.now()` (kèm chốt tăng dần trong process) — đồng hồ tường
//      tăng đơn điệu qua nhiều tiến trình mà không cần file state nào.
//   3. `report-agent` KHÔNG nhận `done`. `done` là state herdr tự suy ra khi tiến trình
//      chết; giữ quyền bằng seq cao sẽ ĐÈ MẤT nó — tiến trình chết mà panel vẫn
//      `working`. Nên `spawn()` claim `working` thì phải có đường `release()`, và
//      `orphanPanes()` là lưới an toàn cho lúc quên.
//   4. Không có fleet (phiên headless) thì cả nhánh này vô nghĩa — `available()` trả lý
//      do để caller rơi về `run-role --exec`.
//
// CLI đổi giữa các minor (0.7→0.8 xoá cả nhóm `wait`). Hằng số dưới là bản đã kiểm
// chứng; adapter health so với `herdr --version`, doctor báo generic `BACKEND-HEALTH`.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

/** Bản herdr mà module này đã được kiểm chứng trên. Đồng bộ với skills/herdr/SKILL.md. */
const VERIFIED_VERSION = "0.8.0";

/** `--source` cho mọi lệnh report/release — panel phân biệt ai đang giữ quyền. */
const SOURCE = "alp";

const BIN = process.platform === "win32" ? "herdr.exe" : "herdr";

// ---------------------------------------------------------------- gọi CLI

function herdr(args, timeout = 15000) {
  const r = spawnSync(BIN, args, { encoding: "utf8", timeout });
  if (r.error) throw new Error(`không chạy được \`herdr\`: ${r.error.message}`);
  if (r.status !== 0)
    throw new Error(`herdr ${args.join(" ")} → exit ${r.status}: ${(r.stderr || r.stdout || "").trim()}`);
  return r.stdout || "";
}

/** herdr in JSON một dòng cho mọi lệnh trừ `--version` và `status`. */
function herdrJson(args, timeout = 15000) {
  const out = herdr(args, timeout);
  try {
    return JSON.parse(out).result;
  } catch (e) {
    throw new Error(`herdr ${args.join(" ")} trả về không phải JSON: ${out.slice(0, 200)}`);
  }
}

/** Bản herdr đang cài, hoặc null nếu không có trên PATH. */
function version() {
  try {
    return herdr(["--version"], 5000).trim().replace(/^herdr\s+/, "");
  } catch {
    return null;
  }
}

/**
 * Fleet có dùng được không. `{ ok: true, version }` hoặc `{ ok: false, reason }`.
 * KHÔNG ném lỗi: caller dùng kết quả này để quyết định rơi về `--exec`, và "không có
 * fleet" là trạng thái bình thường của phiên headless, không phải sự cố.
 */
function available() {
  const v = version();
  if (!v) return { ok: false, reason: "không có `herdr` trên PATH" };

  let out;
  try {
    out = herdr(["status", "server"], 5000);
  } catch (e) {
    return { ok: false, reason: `herdr status server lỗi: ${e.message}` };
  }
  if (!/^status:\s*running/m.test(out))
    return { ok: false, reason: "herdr server chưa chạy (`herdr server >/dev/null 2>&1 &`)" };
  if (/^compatible:\s*no/m.test(out))
    return { ok: false, reason: "herdr server không tương thích protocol của CLI đang cài" };

  return { ok: true, version: v };
}

// ---------------------------------------------------------------- luật định tuyến

/**
 * pane hay exec — luật CỨNG, không để model tự cân từng lần.
 *
 * Không có luật rõ thì cùng một hình dạng việc sẽ đi hai đường khác nhau giữa hai phiên,
 * và đó đúng là lúc khó debug nhất. Hàm này là nơi DUY NHẤT quyết định;
 * `_shared/DELEGATION.md` chỉ chép lại bảng cho người đọc.
 *
 * `shape`: { roles, minutes, interactive, concerns, fleet }
 */
function route(shape = {}) {
  const {
    roles = 1,
    minutes = 0,
    interactive = false,
    concerns = 1,
    fleet = true,
  } = shape;

  // Không có fleet thì không có pane để mở — mọi luật còn lại vô nghĩa.
  if (!fleet) return { via: "exec", why: "không có fleet (phiên headless)" };

  if (roles >= 2) return { via: "pane", why: "≥2 vai song song" };
  if (minutes > 1) return { via: "pane", why: ">1 phút" };
  if (interactive) return { via: "pane", why: "cần theo dõi/tương tác giữa chừng" };
  if (concerns > 1) return { via: "pane", why: "review nhiều concern" };

  return { via: "exec", why: "một câu hỏi, đồng bộ, <1 phút" };
}

// ---------------------------------------------------------------- seq

let lastSeq = 0;

/**
 * Seq tăng nghiêm ngặt, không cần file state.
 *
 * `Date.now()` tăng đơn điệu qua nhiều tiến trình; `lastSeq + 1` lo phần trong một
 * tiến trình khi hai lệnh cách nhau dưới 1ms. Đây là chỗ DUY NHẤT sinh seq — model
 * tự đếm là cách chắc chắn nhất để gửi một seq bằng seq trước và bị bỏ qua im lặng.
 */
function nextSeq() {
  const seq = Math.max(Date.now(), lastSeq + 1);
  lastSeq = seq;
  return seq;
}

// ---------------------------------------------------------------- pane

/** Pane đang focus (chỉ có khi lệnh chạy TRONG một pane herdr). null nếu không xác định. */
function currentPane() {
  try {
    return herdrJson(["pane", "current"], 5000).pane?.pane_id || null;
  } catch {
    return null;
  }
}

/** Pane bất kỳ để làm mỏ neo khi không đứng trong pane nào. */
function anyPane() {
  try {
    return herdrJson(["pane", "list"], 5000).panes?.[0]?.pane_id || null;
  } catch {
    return null;
  }
}

function processInfo(pane) {
  return herdrJson(["pane", "process-info", "--pane", pane], 5000).process_info;
}

/**
 * Pane có đang ở dấu nhắc shell không?
 *
 * Dấu hiệu đã đo (0.8.0): process group đang chiếm foreground CHÍNH LÀ shell của pane.
 * Có agent chạy thì foreground group là tiến trình agent, khác `shell_pid`.
 * Đọc trạng thái thật, không đoán qua ảnh màn hình.
 */
function atShellPrompt(pane) {
  const info = processInfo(pane);
  return (
    info.shell_pid != null && info.foreground_process_group_id === info.shell_pid
  );
}

/** Chờ pane về dấu nhắc shell. Ném lỗi khi hết giờ — `agent start` sớm là `agent_pane_busy`. */
function waitForShell(pane, timeoutMs = 15000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    try {
      if (atShellPrompt(pane)) return true;
      last = null;
    } catch (e) {
      last = e.message; // pane vừa tạo có thể chưa có process-info — thử lại
    }
    if (Date.now() >= deadline)
      throw new Error(
        `pane ${pane} chưa về dấu nhắc shell sau ${timeoutMs}ms` + (last ? ` (${last})` : "")
      );
    sleep(intervalMs);
  }
}

/** Ngủ đồng bộ. Cả module là chuỗi lệnh tuần tự — async ở đây chỉ thêm bề mặt sai. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Tách pane mới. `env` là các biến truyền cho shell của pane đó. */
function split({ anchor, cwd, direction = "down", env = {} }) {
  const args = ["pane", "split", "--pane", anchor, "--direction", direction, "--no-focus"];
  if (cwd) args.push("--cwd", cwd);
  // `--no-focus` bắt buộc: spawn nhiều vai mà cướp focus thì principal mất màn hình.
  for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
  const pane = herdrJson(args, 10000).pane?.pane_id;
  if (!pane) throw new Error("herdr pane split không trả về pane_id");
  return pane;
}

// ---------------------------------------------------------------- agent

/**
 * herdr TỪ CHỐI arg có xuống dòng — `invalid_agent_argument: agent arguments cannot be
 * encoded safely for the target shell` (đo trên 0.8.0; backtick, `#`, nháy thì qua được).
 *
 * Mà prompt delegation LUÔN nhiều dòng: khuôn sáu mục ở `_shared/DELEGATION.md` cộng
 * contract ủy nhiệm. Ép một dòng là mất khuôn, nên arg nhiều dòng được ghi ra file rồi
 * thay bằng MỘT dòng trỏ tới file đó. Vai đọc file trước, rồi làm.
 *
 * `pointer(file)` do caller đưa vào: dòng thay thế phải mang theo NGUỒN ỦY NHIỆM, không
 * chỉ đường dẫn — xem `lib/delegation.cjs:delegatedPromptPointer`.
 *
 * File nằm ở tmp chứ không trong repo: nó là thứ dùng một lần cho một lần chạy, không
 * phải artifact — và vai phụ chạy read-only nên không tự dọn được.
 */
function externalizeArgs(argv, label, pointer = defaultPointer) {
  const files = [];
  const out = argv.map((arg, i) => {
    if (typeof arg !== "string" || !arg.includes("\n")) return arg;
    const dir = path.join(os.tmpdir(), "alp-delegation");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${label}-${i}.md`);
    fs.writeFileSync(file, arg.endsWith("\n") ? arg : arg + "\n");
    files.push(file);
    return pointer(file);
  });
  return { argv: out, files };
}

const defaultPointer = (file) =>
  `Nhiệm vụ của bạn nằm trong file ${file} — đọc file đó trước, rồi làm đúng nội dung trong đó.`;

/**
 * `agent start`, có thử lại khi pane chưa sẵn sàng.
 *
 * ĐO TRÊN 0.8.0: `foreground_process_group_id == shell_pid` là điều kiện CẦN chứ chưa
 * đủ — shell đang source `.zshrc` vẫn thoả, và `agent start` lúc đó trả
 * `agent_pane_busy: not an available shell`. Điều kiện ĐỦ chỉ herdr biết, nên hỏi thẳng
 * nó: thử lại đúng lỗi đó cho tới khi hết cửa sổ chờ. Thực đo: lần thử thứ hai (~300ms
 * sau lần đầu) đã qua.
 *
 * `--timeout` của herdr phải > 3000ms và ≤ 300000ms — ngoài khoảng là `invalid_agent_timeout`.
 */
function startAgent({ pane, label, kind, argv = [], timeoutMs = 60000, retryMs = 10000 }) {
  const args = ["agent", "start", label, "--kind", kind, "--pane", pane, "--timeout", String(timeoutMs)];
  if (argv.length) args.push("--", ...argv);

  const deadline = Date.now() + retryMs;
  for (;;) {
    try {
      return herdrJson(args, timeoutMs + 15000);
    } catch (e) {
      if (!/agent_pane_busy/.test(e.message) || Date.now() >= deadline) throw e;
      sleep(300);
    }
  }
}

/**
 * Báo state lên panel. `done` KHÔNG hợp lệ ở đây — xem điều 3 đầu file.
 * `report-agent`/`release-agent` in ra RỖNG khi thành công (khác mọi lệnh khác của
 * herdr) — parse JSON kết quả là ném lỗi trên đúng đường thành công.
 */
function report({ pane, label, state, message }) {
  const args = [
    "pane", "report-agent", pane,
    "--source", SOURCE, "--agent", label, "--state", state, "--seq", String(nextSeq()),
  ];
  if (message) args.push("--message", message);
  herdr(args, 5000);
}

/**
 * Trả quyền lifecycle về cho herdr. PHẢI gọi khi việc xong, nếu không herdr suy ra
 * `done` cũng bị seq của mình đè và panel kẹt `working` vĩnh viễn.
 */
function release({ pane, label }) {
  herdr(
    ["pane", "release-agent", pane, "--source", SOURCE, "--agent", label, "--seq", String(nextSeq())],
    5000
  );
}

/** Nhãn agent herdr đang gắn cho pane — chính là `--agent` lúc claim. */
function agentLabel(pane) {
  const agents = herdrJson(["agent", "list"], 5000).agents || [];
  return agents.find((a) => a.pane_id === pane)?.agent || null;
}

/**
 * Trả quyền cho một pane mà không cần nhớ nhãn.
 *
 * ĐO TRÊN 0.8.0: `release-agent` THIẾU `--seq` bị bỏ qua IM LẶNG — exit 0, state không
 * đổi một chút nào. Đó là lý do đường trả quyền phải đi qua đây chứ không phải gõ tay:
 * lệnh gõ tay trông như đã chạy, và panel kẹt `working` mãi mãi.
 */
function releasePane(pane) {
  const label = agentLabel(pane);
  if (!label) throw new Error(`pane ${pane} không có agent nào để trả quyền`);
  release({ pane, label });
  return label;
}

/** Nhãn agent: ngắn, không trùng, đọc ra vai ngay. */
function labelFor(role) {
  return `${role}-${Date.now().toString(36).slice(-4)}`;
}

/**
 * Toàn bộ đường spawn: split → chờ shell → agent start → claim `working`.
 * Trả `{ pane, label }`. Ném lỗi ở bất kỳ bước nào — caller quyết định rơi về `--exec`.
 */
function spawn({ role, kind, argv, cwd, anchor, label, message, pointer, env = {}, waitMs = 15000, startMs = 60000 }) {
  const home = anchor || currentPane() || anyPane();
  if (!home) throw new Error("không tìm được pane mỏ neo để split");

  const agentLabel = label || labelFor(role);
  const external = externalizeArgs(argv, agentLabel, pointer);
  const pane = split({ anchor: home, cwd, env: { ALP_ROLE: role, ...env } });

  waitForShell(pane, waitMs);
  startAgent({ pane, label: agentLabel, kind, argv: external.argv, timeoutMs: startMs });
  // Claim để panel hiện ĐÚNG việc đã giao, không phải một dòng "codex" vô danh.
  report({ pane, label: agentLabel, state: "working", message: message || `${role}: đang chạy` });

  return { pane, label: agentLabel, promptFiles: external.files };
}

/** Snapshot runtime-neutral để HerdrBackend map lifecycle mà không lộ pane ra Core. */
function executionStatus(pane) {
  const agents = herdrJson(["agent", "list"], 5000).agents || [];
  const agent = agents.find((a) => a.pane_id === pane);
  if (!agent) return { status: "failed", error: `không tìm thấy agent cho pane ${pane}` };

  let finished = false;
  try { finished = atShellPrompt(pane); } catch {}
  if (finished) return { status: "completed", runtimeStatus: agent.agent_status };

  const map = {
    queued: "queued",
    starting: "queued",
    working: "running",
    blocked: "running",
    done: "completed",
    failed: "failed",
    cancelled: "cancelled",
  };
  return { status: map[agent.agent_status] || "running", runtimeStatus: agent.agent_status };
}

function waitForExecution(pane, timeoutMs = 0, intervalMs = 500) {
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
  for (;;) {
    const current = executionStatus(pane);
    if (["completed", "failed", "cancelled"].includes(current.status)) return current;
    if (Date.now() >= deadline) return { status: "running", timeout: true };
    sleep(intervalMs);
  }
}

function readPane(pane, lines = 200, invoke = herdr) {
  try {
    // Herdr 0.8 is the exception to the usual JSON envelope: `pane read` returns
    // raw terminal text. Parsing it through `herdrJson` discards valid output.
    return invoke(["pane", "read", pane, "--source", "recent-unwrapped", "--lines", String(lines)], 5000);
  } catch {
    return "";
  }
}

function cancelPane(pane) {
  herdr(["pane", "send-keys", pane, "C-c"], 5000);
}

// ---------------------------------------------------------------- mồ côi

/**
 * Pane mà panel còn báo `working`/`blocked` nhưng tiến trình agent đã chết (pane đã về
 * dấu nhắc shell). Đây là hình dạng của lỗi "quên `release-agent`" — doctor báo,
 * người sửa bằng một lệnh.
 */
function orphanPanes() {
  const agents = herdrJson(["agent", "list"], 5000).agents || [];
  const out = [];
  for (const a of agents) {
    if (!["working", "blocked"].includes(a.agent_status)) continue;
    try {
      if (atShellPrompt(a.pane_id))
        out.push({ pane: a.pane_id, agent: a.agent, status: a.agent_status });
    } catch {
      // pane biến mất giữa chừng — không phải mồ côi, bỏ qua
    }
  }
  return out;
}

module.exports = {
  VERIFIED_VERSION, SOURCE,
  version, available, route,
  nextSeq, currentPane, anyPane, atShellPrompt, waitForShell, split,
  startAgent, externalizeArgs, report, release, agentLabel, releasePane, labelFor, spawn, orphanPanes,
  executionStatus, waitForExecution, readPane, cancelPane,
};
