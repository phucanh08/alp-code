// Interactive backend selection used by `alp init`.

const fs = require("fs");
const readline = require("readline");
const { PassThrough } = require("stream");
const { loadDelegationConfig, writeBackendSelection } = require("./config.cjs");
const { createDelegationService } = require("./create-service.cjs");
const { ensureBackendRuntime } = require("./runtime-installer.cjs");

const LABELS = {
  herdr: "Herdr — terminal workspace/pane runtime",
  paseo: "Paseo — daemon/agent runtime",
};

async function configureInitBackend(options) {
  const repoRoot = options.repoRoot;
  const env = options.env || process.env;
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const config = loadDelegationConfig(repoRoot, env);
  const enabled = Object.entries(config.backends)
    .filter(([, value]) => value.enabled)
    .map(([name]) => name);
  const interactive = options.interactive ?? Boolean(input.isTTY && output.isTTY);

  let selected = options.requested || null;
  if (!selected && interactive)
    selected = await promptBackend({ input, output, enabled, current: config.backend, readLine: options.readLine });

  // `alp init` is also used from scripts/tests. Never surprise a non-interactive caller
  // with a package install; automation can opt in deterministically via --backend.
  if (!selected) {
    output.write(`BACKEND  ${config.backend} (non-interactive; dùng --backend herdr|paseo để chọn và cài)\n`);
    return { backend: config.backend, selected: false, health: null };
  }
  if (!enabled.includes(selected))
    throw new Error(`delegation backend \`${selected}\` không tồn tại hoặc đang disabled`);

  output.write(`BACKEND  chọn ${selected}\n`);
  const ensure = options.ensureRuntime || ensureBackendRuntime;
  const runtime = ensure(selected, {
    env,
    platform: options.platform,
    run: options.run,
    launch: options.launch,
    backendConfig: config.backends[selected],
    log(level, message) {
      output.write(`${String(level).padEnd(9)}${message}\n`);
    },
  });

  // Verify through the adapter contract as well. Installation success alone is not enough:
  // an unsafe Paseo MCP configuration must still be rejected before persisting the choice.
  const candidate = { ...config, backend: selected };
  const health = options.healthCheck
    ? options.healthCheck(selected, candidate)
    : createDelegationService({ repoRoot, config: candidate }).service.health(selected);
  if (!health.ok)
    throw new Error(`backend \`${selected}\` chưa sẵn sàng: ${health.message}${health.remediation ? ` — ${health.remediation}` : ""}`);

  writeBackendSelection(config.stateDir, selected);
  output.write(`DEFAULT  delegation backend = ${selected}\n`);
  output.write(`HEALTH   ${health.status || "healthy"} — ${health.message}\n`);
  return { backend: selected, selected: true, runtime, health };
}

async function promptBackend(options) {
  const choices = options.enabled.filter((name) => LABELS[name]);
  if (!choices.length) throw new Error("không có delegation backend nào được enabled");
  const current = choices.includes(options.current) ? options.current : choices[0];
  if (canUseArrowMenu(options))
    return promptBackendArrowMenu({ ...options, choices, current });

  const readLine = options.readLine || (() => readTerminalLine(options.input));

  options.output.write("\nChọn delegation backend mặc định cho các request tiếp theo:\n");
  choices.forEach((name, index) => {
    options.output.write(`  ${index + 1}) ${LABELS[name]}${name === current ? " (hiện tại)" : ""}\n`);
  });

  for (;;) {
    options.output.write(`Chọn [1-${choices.length}, mặc định ${current}]: `);
    const answer = String(readLine() ?? "").trim().toLowerCase();
    if (!answer) return current;
    const number = Number(answer);
    if (Number.isInteger(number) && number >= 1 && number <= choices.length)
      return choices[number - 1];
    if (choices.includes(answer)) return answer;
    options.output.write(`Không hợp lệ: ${answer}. Nhập ${choices.join(" hoặc ")}.\n`);
  }
}

function canUseArrowMenu(options) {
  return !options.readLine &&
    Boolean(options.input?.isTTY && options.output?.isTTY) &&
    typeof options.input.setRawMode === "function";
}

async function promptBackendArrowMenu(options) {
  const { input, output, choices, current } = options;
  const wasFlowing = input.readableFlowing === true;
  const keypress = options.readKey ? null : createKeypressReader(input);
  const readKey = options.readKey || keypress.read;
  const wasRaw = Boolean(input.isRaw);
  let selectedIndex = Math.max(0, choices.indexOf(current));

  output.write("\nChọn delegation backend mặc định cho các request tiếp theo:\n");
  output.write("\x1b[?25l"); // hide cursor while the menu is active
  try {
    if (!wasRaw) input.setRawMode(true);
    if (keypress && typeof input.resume === "function") input.resume();
    renderArrowMenu(output, choices, current, selectedIndex, false);
    for (;;) {
      const key = await readKey();
      if (key === "up") {
        selectedIndex = (selectedIndex - 1 + choices.length) % choices.length;
        renderArrowMenu(output, choices, current, selectedIndex, true);
      } else if (key === "down") {
        selectedIndex = (selectedIndex + 1) % choices.length;
        renderArrowMenu(output, choices, current, selectedIndex, true);
      } else if (key === "enter") {
        return choices[selectedIndex];
      } else if (key === "cancel") {
        const error = new Error("đã huỷ chọn delegation backend");
        error.code = "PROMPT_CANCELLED";
        throw error;
      }
    }
  } finally {
    keypress?.close();
    // `resume()` is needed for keypress events but must not keep the CLI process alive
    // after selection. Restore a previously non-flowing stdin on Unix and Windows alike.
    if (keypress && !wasFlowing && typeof input.pause === "function") input.pause();
    if (!wasRaw) input.setRawMode(false);
    output.write("\x1b[?25h"); // always restore cursor visibility
  }
}

function renderArrowMenu(output, choices, current, selectedIndex, redraw) {
  if (redraw) readline.moveCursor(output, 0, -(choices.length + 1));
  choices.forEach((name, index) => {
    const pointer = index === selectedIndex ? "❯" : " ";
    const persisted = name === current ? " (hiện tại)" : "";
    readline.clearLine(output, 0);
    readline.cursorTo(output, 0);
    output.write(`  ${pointer} ${LABELS[name]}${persisted}\n`);
  });
  readline.clearLine(output, 0);
  readline.cursorTo(output, 0);
  output.write("↑/↓ chọn · Enter xác nhận · Ctrl+C huỷ\n");
}

/**
 * Node's readline decoder is the cross-platform boundary for terminal keys. In
 * particular, Windows Console/ConPTY input must not be decoded by reading ANSI bytes
 * directly from fd 0. Keep a queue because one Windows input chunk may contain both an
 * arrow and Enter before the async menu installs its next waiter.
 */
function createKeypressReader(input) {
  const decoder = new PassThrough();
  const queued = [];
  const waiting = [];
  let terminalError = null;

  const onKeypress = (sequence, key) => {
    const value = normalizeKeypress(sequence, key);
    const waiter = waiting.shift();
    if (waiter) waiter.resolve(value);
    else queued.push(value);
  };
  const onError = (error) => {
    terminalError = error;
    for (const waiter of waiting.splice(0)) waiter.reject(error);
  };

  // Keep readline's permanent decoder listeners off process.stdin. ALP owns the single
  // forwarding listener below and can remove it completely when the menu closes.
  readline.emitKeypressEvents(decoder);
  decoder.on("keypress", onKeypress);
  const onData = (chunk) => decoder.write(chunk);
  input.on("data", onData);
  input.on("error", onError);

  return {
    read() {
      if (queued.length) return Promise.resolve(queued.shift());
      if (terminalError) return Promise.reject(terminalError);
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    close() {
      input.removeListener("data", onData);
      input.removeListener("error", onError);
      decoder.removeListener("keypress", onKeypress);
      decoder.destroy();
    },
  };
}

function normalizeKeypress(sequence, key = {}) {
  if (key.ctrl && key.name === "c") return "cancel";
  if (key.name === "up") return "up";
  if (key.name === "down") return "down";
  if (["return", "enter"].includes(key.name) || sequence === "\r" || sequence === "\n")
    return "enter";
  return "other";
}

function readTerminalKey(input, options = {}) {
  const first = readTerminalByte(input, options);
  if (first === 3) return "cancel";
  if (first === 10 || first === 13) return "enter";
  if (first !== 27) return "other";

  const second = readTerminalByte(input, options);
  if (second !== 91 && second !== 79) return "other"; // CSI or SS3
  const third = readTerminalByte(input, options);
  if (third === 65) return "up";
  if (third === 66) return "down";
  return "other";
}

function readTerminalLine(input, options = {}) {
  const chunks = [];
  for (;;) {
    const value = readTerminalByte(input, options, true);
    if (value === null) return chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
    if (value === 10) return Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
    chunks.push(Buffer.from([value]));
  }
}

function readTerminalByte(input, options = {}, allowEof = false) {
  const fd = Number.isInteger(input.fd) ? input.fd : 0;
  const read = options.read || fs.readSync;
  const pause = options.pause || pauseSync;
  const byte = Buffer.alloc(1);
  for (;;) {
    let count;
    try {
      count = read(fd, byte, 0, 1, null);
    } catch (error) {
      // Node's TTY stream may keep stdin in O_NONBLOCK mode. A synchronous read then
      // reports EAGAIN while the user is still thinking instead of waiting for input.
      if (["EAGAIN", "EWOULDBLOCK"].includes(error?.code)) {
        pause(25);
        continue;
      }
      if (error?.code === "EINTR") continue;
      throw error;
    }
    if (count === 0) {
      if (allowEof) return null;
      const error = new Error("terminal đóng trong khi đang chọn delegation backend");
      error.code = "PROMPT_EOF";
      throw error;
    }
    return byte[0];
  }
}

function pauseSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

module.exports = {
  LABELS,
  configureInitBackend,
  promptBackend,
  promptBackendArrowMenu,
  createKeypressReader,
  normalizeKeypress,
  readTerminalKey,
  readTerminalLine,
};
