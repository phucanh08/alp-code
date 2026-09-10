import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  InvalidModeSettings,
  applyModeSettings,
  parseModeSettings,
  type ModeSettingsLayer,
} from "../agents/mode-settings";
import { MODE_PROFILES, type ModeProfiles } from "../agents/modes";
import { stateHome } from "../state-paths";

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
