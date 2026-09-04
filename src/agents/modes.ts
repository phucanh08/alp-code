import type {
  AgentDefinition,
  AgentId,
  ReasoningEffort,
  RuntimeId,
  RuntimeModelMap,
  RuntimeReasoningMap,
} from "./types";

/**
 * Dial công suất — bốn nấc `low` · `medium` · `high` · `ultra`.
 *
 * Ý tưởng mượn từ Amp: người dùng không nên phải nhớ model nào giỏi việc gì, câu hỏi duy
 * nhất còn lại là **"việc này khó cỡ nào"**. Nấc trả lời câu đó bằng cách đổi model và mức
 * suy nghĩ của hai ghế duy nhất mà độ khó chạm tới:
 *
 * - `main` — người thật sự làm việc,
 * - `oracle` — người được hỏi khi `main` bí.
 *
 * Sáu vai còn lại (`search`, `librarian`, `read-thread`, `review`, `compaction`, `titling`)
 * không nằm trong dial. Model của chúng là **một phần công việc** chứ không phải một mức cố
 * gắng: `search` cần một con nhanh và giỏi retrieval dù câu hỏi to hay nhỏ, `titling` viết
 * một dòng. Cho chúng leo theo dial chỉ tốn tiền mà không đổi kết quả — đúng chỗ Amp cũng
 * ghim cứng subagent.
 *
 * `high` và `ultra` đảo chỗ hai model mạnh nhất giữa hai ghế, chứ không phải cộng thêm:
 * ở `high` opus cầm bút và fable soi lại; ở `ultra` fable cầm bút còn opus soi lại. Khi việc
 * đã khó tới mức đó thì thứ quyết định kết quả là **con nào cầm bút**.
 *
 * Chỉ dùng model Codex và Claude, và mọi model ở đây phải có mặt trong
 * `MODEL_CONTEXT_WINDOWS` — nếu không, ngưỡng auto-compact mặc định (90% cửa sổ) lặng lẽ
 * biến mất đúng ở nấc đó. Một test giữ điều kiện này.
 */

export const MODE_IDS = ["low", "medium", "high", "ultra"] as const;

export type ModeId = (typeof MODE_IDS)[number];

/**
 * Nấc mặc định khi không ai nói gì — cùng lựa chọn của Amp. `medium` đủ cho phần lớn việc
 * thường ngày; hai nấc trên dành cho việc mà một câu trả lời sai tốn nhiều hơn phần chênh.
 */
export const DEFAULT_MODE: ModeId = "medium";

export interface ModeRoleProfile {
  readonly model: RuntimeModelMap;
  readonly reasoningEffort: RuntimeReasoningMap;
}

export interface ModeProfile {
  /** Một dòng in ra ở `alp --help` và trong report, để nấc tự giải thích được mình. */
  readonly summary: string;
  readonly roles: Readonly<Partial<Record<AgentId, ModeRoleProfile>>>;
}

/** Ghế được hỏi khi bí: giữ ở top mọi nấc — hỏi mà nhận câu yếu hơn thì hỏi làm gì. */
const ORACLE_TOP: ModeRoleProfile = {
  model: { claude: "claude-opus-5", codex: "gpt-5.6-sol" },
  reasoningEffort: { claude: "high", codex: "high" },
};

export const MODE_PROFILES: Readonly<Record<ModeId, ModeProfile>> = Object.freeze({
  low: {
    summary: "việc vặt, câu trả lời nhanh — rẻ và đủ",
    roles: {
      main: {
        model: { claude: "claude-haiku-4-5", codex: "gpt-5.6-luna" },
        reasoningEffort: { claude: "low", codex: "low" },
      },
      oracle: ORACLE_TOP,
    },
  },
  medium: {
    summary: "mặc định — việc thường ngày, sửa và đọc code trong một repo quen",
    roles: {
      main: {
        model: { claude: "claude-sonnet-5", codex: "gpt-5.6-sol" },
        reasoningEffort: { claude: "medium", codex: "medium" },
      },
      oracle: ORACLE_TOP,
    },
  },
  high: {
    summary: "việc khó — refactor xuyên module, bug không tái hiện được ngay",
    roles: {
      main: {
        model: { claude: "claude-opus-5", codex: "gpt-5.6-sol" },
        reasoningEffort: { claude: "high", codex: "xhigh" },
      },
      oracle: {
        model: { claude: "claude-fable-5-1", codex: "gpt-5.6-sol" },
        reasoningEffort: { claude: "high", codex: "xhigh" },
      },
    },
  },
  ultra: {
    summary: "việc mà trả lời sai tốn hơn phần chênh — thiết kế, migration, sự cố",
    roles: {
      main: {
        model: { claude: "claude-fable-5-1", codex: "gpt-5.6-sol" },
        reasoningEffort: { claude: "high", codex: "xhigh" },
      },
      oracle: {
        model: { claude: "claude-opus-5", codex: "gpt-5.6-sol" },
        reasoningEffort: { claude: "high", codex: "xhigh" },
      },
    },
  },
});

function profileFor(role: AgentId, mode: ModeId): ModeRoleProfile | undefined {
  return MODE_PROFILES[mode].roles[role];
}

/** Model của vai ở nấc này — nấc thắng, còn lại là khai báo của chính vai đó. */
export function modelForMode(
  definition: AgentDefinition<unknown>,
  runtime: RuntimeId,
  mode: ModeId,
): string {
  return profileFor(definition.id, mode)?.model[runtime] ?? definition.model[runtime];
}

export function reasoningEffortForMode(
  definition: AgentDefinition<unknown>,
  runtime: RuntimeId,
  mode: ModeId,
): ReasoningEffort {
  return profileFor(definition.id, mode)?.reasoningEffort[runtime]
    ?? definition.reasoningEffort[runtime];
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
