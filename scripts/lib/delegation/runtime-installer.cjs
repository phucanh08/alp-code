// Runtime installation/bootstrapping for `alp init`.
//
// This is deliberately outside Delegation Core: installing a CLI and starting a local
// daemon/server are runtime-maintenance concerns. Core continues to know only the backend
// contract. Commands here follow the public installers documented by Herdr and Paseo.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const HERDR_INSTALL_URL = "https://herdr.dev/install.sh";
const HERDR_WINDOWS_INSTALL_URL = "https://herdr.dev/install.ps1";
const PASEO_PACKAGE = "@getpaseo/cli";

function ensureBackendRuntime(backend, options = {}) {
  const context = {
    env: options.env || process.env,
    platform: options.platform || process.platform,
    run: options.run || defaultRun,
    launch: options.launch || defaultLaunch,
    log: options.log || (() => {}),
    backendConfig: options.backendConfig || {},
  };

  if (backend === "herdr") return ensureHerdr(context);
  if (backend === "paseo") return ensurePaseo(context);
  throw new Error(`Không có runtime installer cho backend \`${backend}\``);
}

function ensureHerdr(context) {
  let command = "herdr";
  let probe = commandProbe(context, command, ["--version"]);
  let installed = false;

  if (!probe.ok) {
    context.log("INSTALL", "Herdr chưa có — đang cài từ installer chính thức");
    installHerdr(context);
    installed = true;
    command = refreshCommand(context, "herdr");
    probe = commandProbe(context, command, ["--version"]);
    if (!probe.ok)
      throw new Error("đã chạy installer Herdr nhưng lệnh `herdr` vẫn chưa dùng được; mở terminal mới rồi chạy lại `alp init`");
  }

  const version = firstLine(probe.output).replace(/^herdr\s+/i, "") || "unknown";
  context.log(installed ? "INSTALLED" : "OK", `Herdr ${version}`);

  let status = herdrServerStatus(context, command);
  if (!status.ok) {
    context.log("START", "Herdr headless server");
    const launched = context.launch(command, ["server"], {
      detached: true,
      stdio: "ignore",
      env: context.env,
    });
    if (launched?.error)
      throw new Error(`không khởi động được Herdr server: ${launched.error.message}`);
    status = waitFor(() => herdrServerStatus(context, command), 5000);
  }

  if (!status.ok) {
    context.log("WARN", "Herdr đã cài nhưng server chưa ready; foreground compatibility vẫn dùng được");
    return { backend: "herdr", command, version, installed, status: "degraded" };
  }
  context.log("HEALTH", "Herdr server running");
  return { backend: "herdr", command, version, installed, status: "healthy" };
}

function ensurePaseo(context) {
  const configured = context.backendConfig.cli || "paseo";
  let command = configured;
  let probe = commandProbe(context, command, ["--version"]);
  let installed = false;

  if (!probe.ok) {
    if (configured !== "paseo")
      throw new Error(`PASEO_CLI/delegation.backends.paseo.cli trỏ tới lệnh không tồn tại: ${configured}`);
    const npm = context.platform === "win32" ? "npm.cmd" : "npm";
    if (!commandProbe(context, npm, ["--version"]).ok)
      throw new Error("thiếu `npm`; cần Node/npm để cài Paseo CLI");
    context.log("INSTALL", `Paseo chưa có — đang cài ${PASEO_PACKAGE}`);
    runChecked(context, npm, ["install", "-g", PASEO_PACKAGE], { stdio: "inherit" });
    installed = true;
    command = refreshCommand(context, "paseo", npm);
    probe = commandProbe(context, command, ["--version"]);
    if (!probe.ok)
      throw new Error("đã cài Paseo nhưng lệnh `paseo` vẫn chưa dùng được; mở terminal mới rồi chạy lại `alp init`");
  }

  const version = firstLine(probe.output) || "unknown";
  context.log(installed ? "INSTALLED" : "OK", `Paseo ${version}`);

  // A remote Paseo host owns its daemon lifecycle. ALP only needs the local CLI client.
  if (context.backendConfig.host && !isLocalHost(context.backendConfig.host))
    return { backend: "paseo", command, version, installed, status: "client-ready" };

  let status = paseoDaemonStatus(context, command);
  if (!status.ok) {
    context.log("START", "Paseo daemon (relay off, MCP auto-injection off)");
    runChecked(
      context,
      command,
      ["daemon", "start", "--no-relay", "--no-inject-mcp"],
      { stdio: "inherit" }
    );
    status = waitFor(() => paseoDaemonStatus(context, command), 8000);
  }
  if (!status.ok)
    throw new Error(`Paseo đã cài nhưng daemon chưa ready: ${status.message || "unreachable"}`);

  context.log("HEALTH", "Paseo daemon reachable");
  return { backend: "paseo", command, version, installed, status: "healthy" };
}

function installHerdr(context) {
  const brew = commandProbe(context, "brew", ["--version"]);
  if (context.platform !== "win32" && brew.ok) {
    runChecked(context, "brew", ["install", "herdr"], { stdio: "inherit" });
    return;
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "alp-herdr-install-"));
  try {
    if (context.platform === "win32") {
      const curl = commandProbe(context, "curl.exe", ["--version"]);
      if (!curl.ok) throw new Error("thiếu `curl.exe` để tải installer Herdr chính thức");
      const script = path.join(temp, "install.ps1");
      runChecked(context, "curl.exe", ["-fsSL", HERDR_WINDOWS_INSTALL_URL, "-o", script]);
      const powershell = commandProbe(context, "powershell.exe", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"])
        .ok ? "powershell.exe" : "pwsh.exe";
      if (!commandProbe(context, powershell, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]).ok)
        throw new Error("thiếu PowerShell để chạy installer Herdr chính thức");
      runChecked(context, powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
        stdio: "inherit",
      });
      return;
    }

    if (!commandProbe(context, "curl", ["--version"]).ok)
      throw new Error("thiếu `curl` để tải installer Herdr chính thức");
    const script = path.join(temp, "install.sh");
    runChecked(context, "curl", ["-fsSL", HERDR_INSTALL_URL, "-o", script]);
    runChecked(context, "sh", [script], { stdio: "inherit" });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function herdrServerStatus(context, command) {
  const result = context.run(command, ["status", "server"], processOptions(context, { encoding: "utf8" }));
  const output = combinedOutput(result);
  return {
    ok: !result.error && result.status === 0 && /status:\s*running/i.test(output),
    message: output.trim(),
  };
}

function paseoDaemonStatus(context, command) {
  const result = context.run(
    command,
    ["daemon", "status", "--json"],
    processOptions(context, { encoding: "utf8" })
  );
  const output = combinedOutput(result);
  if (result.error || result.status !== 0) return { ok: false, message: output.trim() || result.error?.message };
  try {
    const data = JSON.parse(output || "{}");
    const ok = data.connectedDaemon === "reachable" || data.localDaemon === "running";
    return { ok, message: ok ? "reachable" : data.connectedDaemon || data.localDaemon || "unreachable" };
  } catch {
    return { ok: false, message: "Paseo daemon status trả JSON không hợp lệ" };
  }
}

function commandProbe(context, command, args) {
  const result = context.run(command, args, processOptions(context, { encoding: "utf8" }));
  return {
    ok: !result.error && result.status === 0,
    output: combinedOutput(result).trim(),
    error: result.error || null,
  };
}

function refreshCommand(context, name, npm = null) {
  if (commandProbe(context, name, ["--version"]).ok) return name;
  const executable = context.platform === "win32" ? `${name}.cmd` : name;
  const candidates = [];
  const home = context.env.HOME || context.env.USERPROFILE || os.homedir();
  if (name === "herdr") {
    candidates.push(path.join(home, ".local", "bin", context.platform === "win32" ? "herdr.exe" : "herdr"));
  }
  if (name === "paseo" && npm) {
    const prefix = context.run(npm, ["prefix", "-g"], processOptions(context, { encoding: "utf8" }));
    if (!prefix.error && prefix.status === 0) {
      const root = String(prefix.stdout || "").trim();
      candidates.push(context.platform === "win32" ? path.join(root, executable) : path.join(root, "bin", executable));
    }
  }
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    prependPath(context.env, path.dirname(candidate), context.platform);
    return candidate;
  }
  return name;
}

function prependPath(env, directory, platform) {
  const key = platform === "win32" ? (Object.hasOwn(env, "Path") ? "Path" : "PATH") : "PATH";
  const delimiter = platform === "win32" ? ";" : ":";
  const current = env[key] || "";
  const parts = current.split(delimiter).filter(Boolean);
  if (!parts.includes(directory)) env[key] = [directory, ...parts].join(delimiter);
}

function runChecked(context, command, args, options = {}) {
  const result = context.run(command, args, processOptions(context, options));
  if (!result.error && result.status === 0) return result;
  const detail = combinedOutput(result).trim() || result.error?.message || `exit ${result.status}`;
  throw new Error(`lệnh \`${command} ${args.join(" ")}\` thất bại: ${detail}`);
}

function processOptions(context, options) {
  return { ...options, env: context.env };
}

function waitFor(check, timeoutMs) {
  const started = Date.now();
  let latest = check();
  while (!latest.ok && Date.now() - started < timeoutMs) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    latest = check();
  }
  return latest;
}

function isLocalHost(host) {
  return /^(?:https?:\/\/|wss?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(String(host));
}

function combinedOutput(result) {
  return `${result?.stdout || ""}${result?.stderr || ""}`;
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/, 1)[0].trim();
}

function defaultRun(command, args, options) {
  return spawnSync(command, args, options);
}

function defaultLaunch(command, args, options) {
  const child = spawn(command, args, options);
  child.unref();
  return child;
}

module.exports = {
  HERDR_INSTALL_URL,
  HERDR_WINDOWS_INSTALL_URL,
  PASEO_PACKAGE,
  ensureBackendRuntime,
  isLocalHost,
};
