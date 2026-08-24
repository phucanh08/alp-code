const { spawnSync } = require("child_process");

function commandRunner(binary) {
  return (args, options = {}) => {
    const result = spawnSync(binary, args, {
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

module.exports = { commandRunner };
