const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require("../loadout.cjs");
const { InvalidConfiguration } = require("./core/errors.cjs");

function loadDelegationConfig(repoRoot, env = process.env) {
  const file = env.ALP_CONFIG || path.join(repoRoot, "alp.config.yaml");
  let root = {};
  if (fs.existsSync(file)) root = L.parseYaml(fs.readFileSync(file, "utf8"));
  const raw = root.delegation || {};
  const rawBackends = raw.backends || {};
  const fallbackBackend = env.ALP_DELEGATION_FALLBACK || raw.fallback_backend || null;
  const stateDir = env.ALP_DELEGATION_STATE_DIR || raw.state_dir || defaultStateDir(repoRoot, env);
  // `alp delegation switch` là lựa chọn tương tác kiểu `/model`: nó phải thắng default
  // được truyền khi mở session. `switch default` xoá lựa chọn này để quay về env/config.
  const switched = readBackendSelection(stateDir);
  const configured = env.ALP_DELEGATION_BACKEND || raw.backend || "herdr";
  const selected = switched || configured;

  const config = {
    file,
    backend: selected,
    backendSource: switched
      ? "switch"
      : env.ALP_DELEGATION_BACKEND ? "environment" : raw.backend ? "config" : "default",
    fallbackBackend: fallbackBackend || null,
    stateDir: path.resolve(stateDir),
    backends: {
      herdr: {
        enabled: booleanValue(rawBackends.herdr?.enabled, true),
      },
      paseo: {
        enabled: booleanValue(rawBackends.paseo?.enabled, true),
        cli: env.PASEO_CLI || rawBackends.paseo?.cli || "paseo",
        host: env.PASEO_HOST || rawBackends.paseo?.host || null,
        home: env.PASEO_HOME || rawBackends.paseo?.home || null,
        runtimeToolsDisabled: booleanValue(
          env.ALP_PASEO_RUNTIME_TOOLS_DISABLED ?? rawBackends.paseo?.runtime_tools_disabled,
          true
        ),
      },
    },
  };

  if (!config.backends[selected]?.enabled)
    throw new InvalidConfiguration(`Delegation backend \`${selected}\` không tồn tại hoặc đang disabled`);
  if (config.fallbackBackend && !config.backends[config.fallbackBackend]?.enabled)
    throw new InvalidConfiguration(`Fallback backend \`${config.fallbackBackend}\` không tồn tại hoặc đang disabled`);
  return config;
}

function defaultStateDir(repoRoot, env) {
  const home = env.HOME || os.homedir();
  const repoKey = crypto.createHash("sha256").update(path.resolve(repoRoot)).digest("hex").slice(0, 12);
  return path.join(home, ".alp", "delegation", repoKey);
}

function backendSelectionFile(stateDir) {
  return path.join(path.resolve(stateDir), "backend");
}

function readBackendSelection(stateDir) {
  const file = backendSelectionFile(stateDir);
  if (!fs.existsSync(file)) return null;
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    return /^[a-z][a-z0-9-]*$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function writeBackendSelection(stateDir, backend) {
  if (!/^[a-z][a-z0-9-]*$/.test(String(backend)))
    throw new InvalidConfiguration(`Tên delegation backend không hợp lệ: ${backend}`);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = backendSelectionFile(stateDir);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${backend}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return file;
}

function clearBackendSelection(stateDir) {
  fs.rmSync(backendSelectionFile(stateDir), { force: true });
}

function booleanValue(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (["true", "1", "yes", "on"].includes(String(value).toLowerCase())) return true;
  if (["false", "0", "no", "off"].includes(String(value).toLowerCase())) return false;
  throw new InvalidConfiguration(`Giá trị boolean không hợp lệ: ${value}`);
}

module.exports = {
  loadDelegationConfig,
  defaultStateDir,
  backendSelectionFile,
  readBackendSelection,
  writeBackendSelection,
  clearBackendSelection,
  booleanValue,
};
