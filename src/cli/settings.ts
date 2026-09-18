import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import {
  InvalidModeSettings,
  applyModeSettings,
  parseModeSettings,
  type ModeSettingsLayer,
} from "../agents/mode-settings";
import { MODE_PROFILES, type ModeProfiles } from "../agents/modes";
import type { VerifyCommand, VerifySettings } from "../execution/evidence";
import {
  InvalidToolchainSettings,
  defaultHome,
  parseToolchainBlock,
  resolveToolchainWritePaths,
} from "../execution/toolchain";
import { stateHome } from "../state-paths";

export { InvalidModeSettings, InvalidToolchainSettings };

/**
 * Ba file settings, đọc theo thứ tự thắng dần.
 *
 * 1. `~/.alp/settings.json` — của **máy**: hạn mức, CLI nào đã cài, sở thích của một người.
 * 2. `<project>/.alp/settings.json` — của **project**, đi cùng repo, commit được.
 * 3. `<project>/.alp/settings.local.json` — của người này trên project này, không commit.
 *
 * Đúng ba tầng mà Claude Code đã dạy người dùng, và đúng theo thứ tự đó: cái riêng hơn thắng.
 * `.alp/` là thư mục `alp init` đã tạo sẵn, nên không có chỗ mới nào phải học.
 *
 * Thiếu file thì bỏ qua — không cấu hình gì là trạng thái bình thường nhất. File có mà hỏng
 * thì **ném**: file này do người viết tay, và một dòng sai bị bỏ qua trong im lặng sẽ chạy
 * một loadout khác loadout người ta tưởng.
 */
export interface LoadedModeProfiles {
  /** Loadout đã ghép — thứ mọi hàm `*ForMode` phải nhận. */
  readonly profiles: ModeProfiles;
  /** Những file thật sự đọc được, theo thứ tự ghép. Rỗng nghĩa là đang chạy đúng built-in. */
  readonly files: readonly string[];
}

export interface LoadModeProfilesOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Bản built-in để ghép lên. Chỉ test truyền khác. */
  readonly base?: ModeProfiles;
}

/**
 * Gốc project — thư mục cha gần nhất có `.alp/`.
 *
 * Người ta chạy `alp` từ chỗ đang làm, thường là một thư mục con. Không đi ngược lên thì
 * settings của project chỉ có tác dụng khi đứng đúng ở gốc — một hành vi vừa khó đoán vừa
 * không có lý do nào biện minh. Không tìm thấy thì lấy chính `cwd`, và hai file project ở
 * dưới đơn giản là không tồn tại.
 */
export async function projectSettingsRoot(cwd: string): Promise<string> {
  let directory = resolve(cwd);
  for (;;) {
    try {
      if ((await stat(join(directory, ".alp"))).isDirectory()) return directory;
    } catch { /* đi tiếp lên trên */ }
    const parent = dirname(directory);
    if (parent === directory) return resolve(cwd);
    directory = parent;
  }
}

export async function modeSettingsFiles(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly string[]> {
  const projectRoot = await projectSettingsRoot(cwd);
  // `Set` vì `ALP_STATE_HOME` có thể trỏ vào chính `.alp/` của project trong test và trong
  // một cài đặt cô lập — cùng một file đọc hai lần thì lớp sau đè lớp trước bằng chính nó.
  return [...new Set([
    join(stateHome(env), "settings.json"),
    join(projectRoot, ".alp", "settings.json"),
    join(projectRoot, ".alp", "settings.local.json"),
  ])];
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new InvalidModeSettings(`${file}: ${(error as Error).message}`);
  }
}

export async function loadModeProfiles(options: LoadModeProfilesOptions): Promise<LoadedModeProfiles> {
  const env = options.env ?? process.env;
  const layers: ModeSettingsLayer[] = [];
  for (const file of await modeSettingsFiles(options.cwd, env)) {
    const text = await readIfPresent(file);
    if (text === null) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new InvalidModeSettings(`${file}: not valid JSON — ${(error as Error).message}`);
    }
    layers.push({ file, settings: parseModeSettings(raw, file) });
  }
  return {
    profiles: applyModeSettings(options.base ?? MODE_PROFILES, layers),
    files: layers.map((layer) => layer.file),
  };
}

/**
 * Khối `verify` của một project (P3):
 *
 * ```json
 * { "verify": { "commands": [ { "id": "test", "run": "npm test", "timeoutMs": 600000, "cwd": "." } ] } }
 * ```
 *
 * Chỉ hai file **của project** — `settings.json` và `settings.local.json` — không có tầng máy:
 * lệnh verify chạy bằng process ALP trong workspace của project, và một lệnh ở `~/.alp` len
 * vào evidence của mọi project là chính cái lỗ mà `alp trust verify` tồn tại để bịt. File
 * local đè theo `id`. Digest băm đúng danh sách đã ghép — đó là thứ được trust, nên hai
 * project cùng một khối có cùng một digest, và sửa một ký tự là một khối khác.
 */
export const DEFAULT_VERIFY_TIMEOUT_MS = 600_000;

export async function loadVerifyCommands(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<VerifySettings> {
  // `env` đứng đây cho cùng chữ ký với `loadModeProfiles`, và để nói rõ: tầng máy
  // (`stateHome(env)`) *cố ý* không được đọc.
  void env;
  const project = await projectSettingsRoot(cwd);
  const byId = new Map<string, VerifyCommand>();
  let declared = false;
  for (const file of [join(project, ".alp", "settings.json"), join(project, ".alp", "settings.local.json")]) {
    const text = await readIfPresent(file);
    if (text === null) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new InvalidModeSettings(`${file}: not valid JSON — ${(error as Error).message}`);
    }
    const block = parseVerifyBlock(raw, file);
    if (block === null) continue;
    declared = true;
    for (const command of block) byId.set(command.id, command);
  }
  const commands = [...byId.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const digest = declared
    ? createHash("sha256").update(JSON.stringify(commands.map((command) => [command.id, command.run, command.timeoutMs, command.cwd]))).digest("hex")
    : null;
  return { project, commands, digest };
}

const VERIFY_ID = /^[a-z0-9][a-z0-9._-]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `null` khi file không nói gì về verify; ném khi nó nói sai. */
function parseVerifyBlock(raw: unknown, file: string): readonly VerifyCommand[] | null {
  if (!isPlainObject(raw)) throw new InvalidModeSettings(`${file}: settings must be a JSON object`);
  if (raw.verify === undefined) return null;
  if (!isPlainObject(raw.verify) || !Array.isArray(raw.verify.commands)) {
    throw new InvalidModeSettings(`${file}: \`verify\` must be an object with a \`commands\` list`);
  }
  const seen = new Set<string>();
  return raw.verify.commands.map((entry, index) => {
    const where = `${file}: \`verify.commands[${index}]\``;
    if (!isPlainObject(entry)) throw new InvalidModeSettings(`${where} must be an object`);
    const { id, run, timeoutMs, cwd } = entry;
    if (typeof id !== "string" || !VERIFY_ID.test(id)) {
      throw new InvalidModeSettings(`${where}.id must match ${VERIFY_ID}`);
    }
    if (seen.has(id)) throw new InvalidModeSettings(`${where}.id \`${id}\` is listed twice`);
    seen.add(id);
    if (typeof run !== "string" || run.trim() === "") throw new InvalidModeSettings(`${where}.run must be a non-empty command line`);
    if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
      throw new InvalidModeSettings(`${where}.timeoutMs must be a positive integer`);
    }
    if (cwd !== undefined && (typeof cwd !== "string" || cwd === "" || isAbsolute(cwd) || normalize(cwd).split(/[\\/]/).includes(".."))) {
      throw new InvalidModeSettings(`${where}.cwd must be a relative path inside the workspace`);
    }
    return Object.freeze({ id, run, timeoutMs: timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS, cwd: cwd ?? "." });
  });
}

/**
 * Khối `toolchain` của **máy** (GitHub #25) — `~/.alp/settings.json`, và chỉ file đó:
 *
 * ```json
 * { "toolchain": { "presets": ["flutter", "node"], "writePaths": ["~/fvm"] } }
 * ```
 *
 * Ngược với `verify`: khối này mở thư mục *ngoài* workspace cho sandbox của mọi launch trên
 * máy, nên nó phải là của người sở hữu máy. Hai file project mà có khối này thì **ném** —
 * một repo không được mở `~/.ssh` cho bất kỳ ai clone nó, và ở đây không có digest nào để
 * `alp trust` cả. Trả về danh sách đã giải: preset bung ra, `~` thay bằng home, mỗi đường
 * dẫn canonical qua symlink như workspace, sắp xếp, khử trùng. Không khai gì thì `[]`.
 */
export interface LoadedToolchainWritePaths {
  readonly paths: readonly string[];
  /** File đã khai, hoặc `null` khi máy không khai gì. */
  readonly file: string | null;
}

export async function loadToolchainWritePaths(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<LoadedToolchainWritePaths> {
  const machineFile = join(stateHome(env), "settings.json");
  const project = await projectSettingsRoot(cwd);
  const parse = async (file: string) => {
    const text = await readIfPresent(file);
    if (text === null) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new InvalidToolchainSettings(`${file}: not valid JSON — ${(error as Error).message}`);
    }
    return parseToolchainBlock(raw, file);
  };
  // Cùng `Set` như `modeSettingsFiles`: `ALP_STATE_HOME` có thể trỏ vào chính `.alp/` của
  // project, và khi đó file máy *là* file project — không có gì để cấm.
  for (const file of [join(project, ".alp", "settings.json"), join(project, ".alp", "settings.local.json")]) {
    if (file === machineFile) continue;
    if ((await parse(file)) !== null) {
      throw new InvalidToolchainSettings(`${file}: \`toolchain\` is a machine setting; move it to ${machineFile} — a project may not open directories outside itself for whoever clones it`);
    }
  }
  const block = await parse(machineFile);
  if (block === null) return { paths: Object.freeze([]), file: null };
  const canonical = async (path: string): Promise<string | null> => {
    try {
      if (!(await stat(path)).isDirectory()) throw new InvalidToolchainSettings(`${machineFile}: \`toolchain\` entry \`${path}\` is not a directory`);
      return await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const paths = await resolveToolchainWritePaths(block, { home: defaultHome(env), stateHome: stateHome(env), canonical, file: machineFile });
  return { paths, file: machineFile };
}
