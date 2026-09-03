const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function commandRunner(binary) {
  return (args, options = {}) => {
    const result = spawnSyncCommand(binary, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      encoding: "utf8",
      timeout: options.timeoutMs || 30000,
      stdio: options.stdio,
    });
    return {
      status: result.status,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      error: result.error || null,
    };
  };
}

/**
 * Node cannot execute npm-generated `.cmd` shims directly on Windows. Resolve PATHEXT
 * ourselves, then opt into a shell only for batch files; native executables stay on the
 * safer direct-spawn path.
 */
function spawnSyncCommand(binary, args, options = {}, platform = process.platform) {
  const resolved = platform === "win32"
    ? resolveWindowsCommand(binary, options.env || process.env)
    : binary;
  if (platform === "win32" && /\.(?:cjs|mjs|js)$/i.test(resolved))
    return spawnSync(process.execPath, [resolved, ...args], options);
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(resolved)) {
    const shim = resolveNpmNodeShim(resolved);
    if (shim) return spawnSync(process.execPath, [...shim.args, ...args], options);
    return unsupportedBatchResult(resolved);
  }
  return spawnSync(resolved, args, options);
}

/** Resolve npm/npm-generated Windows shims without a command shell, preserving argv. */
function resolveNpmNodeShim(file) {
  const directory = path.dirname(file);
  const base = path.basename(file).toLowerCase();
  const npmEntry = base === "npm.cmd"
    ? path.join(directory, "node_modules", "npm", "bin", "npm-cli.js")
    : base === "npx.cmd"
      ? path.join(directory, "node_modules", "npm", "bin", "npx-cli.js")
      : null;
  if (npmEntry && fs.existsSync(npmEntry)) return { args: [npmEntry] };

  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch { return null; }
  const launch = text.match(/"%_prog%"\s+(.+?)\s+%\*\s*$/mi);
  if (!launch) return null;
  const tokens = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(launch[1])))
    tokens.push((match[1] ?? match[2]).replace(/%dp0%/gi, directory));
  return tokens.length ? { args: tokens } : null;
}

function unsupportedBatchResult(file) {
  const error = new Error(`Windows batch shim không được hỗ trợ an toàn: ${file}`);
  error.code = "ENOTSUP";
  return { status: null, stdout: "", stderr: "", error };
}

function resolveWindowsCommand(binary, env = process.env) {
  const command = String(binary || "");
  if (!command) return command;

  const pathValue = envValue(env, "PATH");
  const pathExt = envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD";
  const extensions = path.extname(command)
    ? [""]
    : pathExt.split(";").map((value) => value.trim()).filter(Boolean);
  const directories = /[\\/]/.test(command)
    ? [""]
    : pathValue.split(";").map((value) => value.trim().replace(/^"|"$/g, "")).filter(Boolean);
  // npm's per-user global bin is not guaranteed to be on PATH in existing terminals.
  // Its Windows default is `%APPDATA%\npm`; checking it keeps ALP self-contained without
  // mutating the user's persistent PATH just to find a tool ALP needs to spawn.
  if (!/[\\/]/.test(command) && env.APPDATA) {
    const npmGlobalBin = path.join(env.APPDATA, "npm");
    if (!directories.some((value) => value.toLowerCase() === npmGlobalBin.toLowerCase()))
      directories.push(npmGlobalBin);
  }

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = directory ? path.join(directory, command + extension) : command + extension;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return command;
}

function envValue(env, name) {
  if (Object.hasOwn(env || {}, name)) return String(env[name] || "");
  const key = Object.keys(env || {}).find((candidate) => candidate.toUpperCase() === name);
  return key ? String(env[key] || "") : "";
}

module.exports = { commandRunner, resolveNpmNodeShim, resolveWindowsCommand, spawnSyncCommand };
