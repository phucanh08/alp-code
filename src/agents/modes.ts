import { runtimeForModel } from "./model-context";
import type {
  AgentDefinition,
  AgentId,
  ReasoningEffort,
  RuntimeId,
} from "./types";

/**
 * Dial công suất — `low` · `medium` · `high` · `ultra`, cộng `puck`.
 *
 * Ý tưởng mượn từ Amp: người dùng không nên phải nhớ model nào giỏi việc gì, câu hỏi duy
 * nhất còn lại là **"việc này khó cỡ nào"**. Nấc trả lời câu đó bằng một **loadout hoàn
 * chỉnh**: mỗi vai đúng **một** model và một mức suy nghĩ.
 *
 * Một model cho mỗi vai kéo theo một hệ quả lớn: **model quyết định runtime**. `claude-*`
 * phóng Claude Code, `gpt-*` phóng Codex CLI (`MODEL_RUNTIMES`). Không còn bước "chọn
 * runtime rồi tra model" — nấc là lựa chọn duy nhất, và một nấc có thể trộn hai CLI trong
 * cùng một phiên, đúng như Amp trộn. `oracle` luôn đứng ở runtime **đối diện** `main` — người
 * được hỏi khi bí phải là một cách nhìn khác, không phải cùng model tự hỏi lại chính nó
 * (vd `medium`: main Sol/Codex, oracle Opus 5/Claude).
 *
 * Bốn nấc dial chỉ xoay hai ghế mà độ khó chạm tới — `main` (người làm) và `oracle` (người
 * được hỏi khi bí). Sáu vai còn lại giữ nguyên qua cả bốn nấc, đúng chỗ Amp ghim cứng
 * subagent: model của chúng là **một phần công việc** chứ không phải một mức cố gắng —
 * `search` cần retrieval nhanh dù câu hỏi to hay nhỏ, `titling` viết một dòng.
 *
 * `puck` nằm ngoài trục độ khó: nó là câu trả lời cho "chạy toàn Codex", cho máy chỉ cài
 * `codex`, cho lúc hạn mức Claude đã hết, hoặc cho người muốn đúng loadout Amp mặc định.
 */

export const MODE_IDS = ["low", "medium", "high", "ultra", "puck"] as const;

export type ModeId = (typeof MODE_IDS)[number];

/**
 * Nấc mặc định khi không ai nói gì — cùng lựa chọn của Amp. `medium` đủ cho phần lớn việc
 * thường ngày; hai nấc trên dành cho việc mà một câu trả lời sai tốn nhiều hơn phần chênh.
 */
export const DEFAULT_MODE: ModeId = "medium";

export interface ModeRoleProfile {
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
}

export interface ModeProfile {
  /** Một dòng in ra ở `alp --help` và trong menu chọn nấc, để nấc tự giải thích được mình. */
  readonly summary: string;
  readonly roles: Readonly<Record<AgentId, ModeRoleProfile>>;
}

/**
 * Sáu vai không nằm trên trục độ khó, giống nhau ở cả bốn nấc dial.
 *
 * `search` và `librarian` lấy thẳng lựa chọn của Amp (Terra cho search, Sol cho librarian):
 * đó là hai việc retrieval thuần, nơi nhanh và rẻ ăn đứt sâu sắc. Bốn vai còn lại ở phía
 * Claude, giữ đúng loadout ALP đang chạy trước khi có dial.
 */
const FIXED_ROLES: Readonly<Record<AgentId, ModeRoleProfile>> = Object.freeze({
  search: { model: "gpt-5.6-terra", reasoningEffort: "low" },
  librarian: { model: "gpt-5.6-sol", reasoningEffort: "high" },
  "read-thread": { model: "claude-haiku-4-5", reasoningEffort: "low" },
  review: { model: "claude-opus-5", reasoningEffort: "high" },
  compaction: { model: "claude-opus-5", reasoningEffort: "medium" },
  titling: { model: "claude-haiku-4-5", reasoningEffort: "low" },
});

export const MODE_PROFILES: Readonly<Record<ModeId, ModeProfile>> = Object.freeze({
  low: {
    summary: "việc vặt, câu trả lời nhanh — rẻ và đủ",
    roles: {
      ...FIXED_ROLES,
      main: { model: "claude-sonnet-5", reasoningEffort: "high" },
      oracle: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    },
  },
  medium: {
    summary: "mặc định — việc thường ngày, sửa và đọc code trong một repo quen",
    roles: {
      ...FIXED_ROLES,
      main: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      oracle: { model: "claude-opus-5", reasoningEffort: "high" },
    },
  },
  high: {
    summary: "việc khó — refactor xuyên module, bug không tái hiện được ngay",
    roles: {
      ...FIXED_ROLES,
      main: { model: "claude-opus-5", reasoningEffort: "high" },
      oracle: { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
    },
  },
  ultra: {
    summary: "việc mà trả lời sai tốn hơn phần chênh — thiết kế, migration, sự cố",
    roles: {
      ...FIXED_ROLES,
      main: { model: "claude-opus-5", reasoningEffort: "high" },
      oracle: { model: "gpt-6-astra", reasoningEffort: "high" },
    },
  },
  puck: {
    summary: "toàn Codex — máy chỉ có `codex`, hết hạn mức Claude, hoặc muốn đúng loadout Amp",
    roles: {
      main: { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
      oracle: { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
      search: { model: "gpt-5.6-terra", reasoningEffort: "low" },
      librarian: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      "read-thread": { model: "gpt-5.6-luna", reasoningEffort: "low" },
      review: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
      compaction: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
      titling: { model: "gpt-5.6-luna", reasoningEffort: "low" },
    },
  },
});

/**
 * Runtime "nhà" của một nấc — runtime của ghế `main`.
 *
 * Chỉ dùng làm chỗ dựa cho vai **không** có trong loadout (custom agent mai này): nó vẫn
 * khai `model: {claude, codex}`, và phía được chọn là phía mà nấc đang đứng. Tám vai
 * built-in đều có mặt trong mọi nấc nên không bao giờ đi qua nhánh này.
 */
export function homeRuntimeForMode(mode: ModeId): RuntimeId {
  return runtimeForModel(MODE_PROFILES[mode].roles.main.model);
}

export function modelForMode(definition: AgentDefinition<unknown>, mode: ModeId): string {
  const profile = MODE_PROFILES[mode].roles[definition.id];
  return profile?.model ?? definition.model[homeRuntimeForMode(mode)];
}

export function reasoningEffortForMode(
  definition: AgentDefinition<unknown>,
  mode: ModeId,
): ReasoningEffort {
  const profile = MODE_PROFILES[mode].roles[definition.id];
  return profile?.reasoningEffort ?? definition.reasoningEffort[homeRuntimeForMode(mode)];
}

/** CLI nào phóng vai này ở nấc này — suy từ model, vì model mới là thứ được chạy. */
export function runtimeForMode(definition: AgentDefinition<unknown>, mode: ModeId): RuntimeId {
  return runtimeForModel(modelForMode(definition, mode));
}

export function isModeId(value: unknown): value is ModeId {
  return typeof value === "string" && (MODE_IDS as readonly string[]).includes(value);
}

/**
 * Fail-closed: một nấc gõ sai (`--mode smart`, `ALP_MODE=deep`) không được lặng lẽ rơi về
 * mặc định, vì lúc đó người dùng tin mình đang chạy nấc khác với nấc thật sự chạy.
 */
export function parseMode(value: unknown): ModeId {
  if (isModeId(value)) return value;
  throw new Error(`mode must be one of ${MODE_IDS.join(", ")}, received \`${String(value)}\``);
}
