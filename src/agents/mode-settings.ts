import { MODEL_RUNTIMES } from "./model-context";
import { MODE_IDS, MODE_PROFILES, isModeId, type ModeId, type ModeProfiles, type ModeRoleProfile } from "./modes";
import { REASONING_EFFORTS, type AgentId, type ReasoningEffort } from "./types";

/**
 * Nấc do người dùng sửa — `settings.json` / `settings.local.json`.
 *
 * Dial trả lời "việc này khó cỡ nào" bằng một loadout ALP chọn sẵn. Chọn sẵn là đúng cho
 * người mới, nhưng không đúng mãi: một máy hết hạn mức Claude, một project bắt buộc chạy
 * on-prem, một người biết rõ `review` của họ nên đứng ở model nào. Trước đây câu trả lời duy
 * nhất là sửa `MODE_PROFILES` rồi build lại — tức là fork ALP để đổi một dòng cấu hình.
 *
 * Nên loadout mở ra ở đúng chỗ nó là dữ liệu: **model nào và mức nghĩ nào cho vai nào, ở nấc
 * nào**. Không mở gì thêm. Vai được cấp quyền gì, delegate cho ai, đọc ghi memory ở đâu —
 * những thứ đó là *authority*, và authority không nằm trong một file mà ai cũng ghi được.
 *
 * ```json
 * {
 *   "modes": {
 *     "*":    { "titling": { "model": "gpt-5.6-luna" } },
 *     "high": { "worker": { "model": "claude-opus-5", "reasoningEffort": "max" } }
 *   }
 * }
 * ```
 *
 * `"*"` áp cho cả năm nấc và được ghép **trước** phần ghi đè của từng nấc, nên một dòng
 * chung không bao giờ đè lên một dòng nói rõ nấc.
 *
 * Fail-closed ở mọi chỗ đọc được: nấc lạ, khoá lạ, model không có trong `MODEL_RUNTIMES`,
 * mức nghĩ không tồn tại — tất cả đều ném, kèm tên file. Một file settings bị bỏ qua trong
 * im lặng còn tệ hơn không có file: người dùng tin mình đang chạy Opus trong khi phiên chạy
 * Sonnet, và không có gì trên màn hình nói khác đi.
 */

/** Khoá áp cho mọi nấc. Ghép trước phần của từng nấc — nói chung thua nói riêng. */
export const ALL_MODES = "*";

export interface ModeRoleOverride {
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
}

export interface ModeSettings {
  readonly modes: Readonly<Record<string, Readonly<Record<AgentId, ModeRoleOverride>>>>;
}

/** Một file settings đã đọc và đã kiểm — `file` đi kèm để mọi lỗi chỉ được đúng chỗ sửa. */
export interface ModeSettingsLayer {
  readonly file: string;
  readonly settings: ModeSettings;
}

export class InvalidModeSettings extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidModeSettings";
  }
}

export const EMPTY_MODE_SETTINGS: ModeSettings = Object.freeze({ modes: Object.freeze({}) });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRoleOverride(raw: unknown, where: string): ModeRoleOverride {
  if (!isPlainObject(raw)) {
    throw new InvalidModeSettings(`${where} must be an object with \`model\` and/or \`reasoningEffort\``);
  }
  const unknownKeys = Object.keys(raw).filter((key) => key !== "model" && key !== "reasoningEffort");
  if (unknownKeys.length > 0) {
    throw new InvalidModeSettings(
      `${where} has unknown key${unknownKeys.length > 1 ? "s" : ""} ${unknownKeys.map((key) => `\`${key}\``).join(", ")}; only \`model\` and \`reasoningEffort\` are settable`,
    );
  }
  const override: { model?: string; reasoningEffort?: ReasoningEffort } = {};
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string" || raw.model === "") {
      throw new InvalidModeSettings(`${where}.model must be a model name`);
    }
    // Model quyết định CLI nào được phóng, và `MODEL_RUNTIMES` là bảng duy nhất biết điều đó.
    // Một tên lạ ở đây sẽ không hỏng lúc đọc file mà hỏng lúc phóng phiên, nên nó dừng ở đây.
    if (MODEL_RUNTIMES[raw.model] === undefined) {
      throw new InvalidModeSettings(
        `${where}.model \`${raw.model}\` chưa được gán runtime; chọn một trong ${Object.keys(MODEL_RUNTIMES).join(", ")}`,
      );
    }
    override.model = raw.model;
  }
  if (raw.reasoningEffort !== undefined) {
    if (!(REASONING_EFFORTS as readonly unknown[]).includes(raw.reasoningEffort)) {
      throw new InvalidModeSettings(
        `${where}.reasoningEffort must be one of ${REASONING_EFFORTS.join(", ")}, received \`${String(raw.reasoningEffort)}\``,
      );
    }
    override.reasoningEffort = raw.reasoningEffort as ReasoningEffort;
  }
  if (override.model === undefined && override.reasoningEffort === undefined) {
    throw new InvalidModeSettings(`${where} sets nothing; give it \`model\`, \`reasoningEffort\`, or drop it`);
  }
  return Object.freeze(override);
}

/**
 * Đọc phần `modes` của một file settings.
 *
 * Khoá lạ ở **gốc** file thì bỏ qua: `settings.json` là chỗ ở chung, và ALP không phải chủ
 * duy nhất của nó. Khoá lạ **bên trong** `modes` thì ném — đó là chỗ một lỗi chính tả không
 * làm gì cả mà vẫn trông như đã làm.
 */
export function parseModeSettings(raw: unknown, file: string): ModeSettings {
  if (!isPlainObject(raw)) throw new InvalidModeSettings(`${file}: settings must be a JSON object`);
  if (raw.modes === undefined) return EMPTY_MODE_SETTINGS;
  if (!isPlainObject(raw.modes)) throw new InvalidModeSettings(`${file}: \`modes\` must be an object`);

  const modes: Record<string, Record<AgentId, ModeRoleOverride>> = {};
  for (const [modeKey, rolesRaw] of Object.entries(raw.modes)) {
    if (modeKey !== ALL_MODES && !isModeId(modeKey)) {
      throw new InvalidModeSettings(
        `${file}: \`modes.${modeKey}\` is not a mode; expected ${MODE_IDS.join(", ")} or "${ALL_MODES}"`,
      );
    }
    if (!isPlainObject(rolesRaw)) {
      throw new InvalidModeSettings(`${file}: \`modes.${modeKey}\` must map a role to its model and effort`);
    }
    const roles: Record<AgentId, ModeRoleOverride> = {};
    for (const [role, overrideRaw] of Object.entries(rolesRaw)) {
      if (role === "") throw new InvalidModeSettings(`${file}: \`modes.${modeKey}\` has an empty role name`);
      roles[role] = parseRoleOverride(overrideRaw, `${file}: \`modes.${modeKey}.${role}\``);
    }
    modes[modeKey] = Object.freeze(roles);
  }
  return Object.freeze({ modes: Object.freeze(modes) });
}

interface AccumulatedOverride {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  where: string;
}

/**
 * Ghép các lớp settings lên loadout built-in.
 *
 * Thứ tự lớp là thứ tự thắng: máy → project → local, lớp sau đè lớp trước, và trong một lớp
 * thì `"*"` thua khoá nói rõ nấc. Vai chưa có trong loadout (custom agent) vẫn ghi đè được,
 * nhưng phải khai **đủ cả hai** — không có sẵn nửa nào để mượn, và đoán nốt nửa còn lại là
 * đúng cái im lặng mà file này sinh ra để tránh.
 */
export function applyModeSettings(
  base: ModeProfiles = MODE_PROFILES,
  layers: readonly ModeSettingsLayer[] = [],
): ModeProfiles {
  if (layers.length === 0) return base;
  const profiles: Record<string, { summary: string; roles: Record<AgentId, ModeRoleProfile> }> = {};
  for (const mode of MODE_IDS) {
    const accumulated = new Map<AgentId, AccumulatedOverride>();
    for (const layer of layers) {
      for (const section of [ALL_MODES, mode] as const) {
        for (const [role, override] of Object.entries(layer.settings.modes[section] ?? {})) {
          const current = accumulated.get(role) ?? { where: "" };
          accumulated.set(role, {
            ...current,
            ...(override.model === undefined ? {} : { model: override.model }),
            ...(override.reasoningEffort === undefined ? {} : { reasoningEffort: override.reasoningEffort }),
            where: `${layer.file}: \`modes.${section}.${role}\``,
          });
        }
      }
    }
    const roles: Record<AgentId, ModeRoleProfile> = { ...base[mode].roles };
    for (const [role, override] of accumulated) {
      const model = override.model ?? roles[role]?.model;
      const reasoningEffort = override.reasoningEffort ?? roles[role]?.reasoningEffort;
      if (model === undefined || reasoningEffort === undefined) {
        throw new InvalidModeSettings(
          `${override.where} pins a role that mode \`${mode}\` carries no loadout for, so it must give both \`model\` and \`reasoningEffort\``,
        );
      }
      roles[role] = Object.freeze({ model, reasoningEffort });
    }
    profiles[mode] = { summary: base[mode].summary, roles: Object.freeze(roles) };
  }
  return Object.freeze(profiles) as ModeProfiles;
}

export interface ModeOverrideRow {
  readonly role: AgentId;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly builtIn: ModeRoleProfile | null;
}

/**
 * Vai nào ở nấc này đang chạy khác built-in — thứ `alp mode show` in ra.
 *
 * So bản đã ghép với bản built-in thay vì đọc lại các lớp settings: cái người dùng cần biết
 * là phiên tới sẽ chạy gì, không phải file nào đã nói gì.
 */
export function modeOverrides(
  mode: ModeId,
  profiles: ModeProfiles,
  base: ModeProfiles = MODE_PROFILES,
): readonly ModeOverrideRow[] {
  const rows: ModeOverrideRow[] = [];
  for (const [role, profile] of Object.entries(profiles[mode].roles)) {
    const builtIn = base[mode].roles[role] ?? null;
    if (builtIn && builtIn.model === profile.model && builtIn.reasoningEffort === profile.reasoningEffort) continue;
    rows.push({ role, model: profile.model, reasoningEffort: profile.reasoningEffort, builtIn });
  }
  return rows.sort((left, right) => left.role.localeCompare(right.role));
}
