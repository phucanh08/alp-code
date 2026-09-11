import type { AgentRegistry } from "../agents/types";
import { ALLOW, deny, type Authorization } from "./types";

/**
 * Ai được khởi chạy ai.
 *
 * Một nguồn quyền duy nhất: `actor.delegatesTo`. `reportsTo` từng được kiểm ở đây như điều
 * kiện thứ hai, và đó là một lỗi về mặt mô hình — `reportsTo` mô tả tổ chức ("báo cáo kết quả
 * cho ai"), không phải quyền hạn. Hai nguồn quyền cho cùng một câu hỏi nghĩa là mở một grant
 * ở `delegatesTo` mà vẫn bị chặn ở chỗ khác, hoặc tệ hơn, tin rằng đã chặn ở chỗ này trong
 * khi thứ thật sự chặn là chỗ kia. `delegatesTo` là allowlist, và một allowlist rỗng — như
 * `worker` — đã fail đóng mà không cần điều kiện nào thêm.
 */
export class DelegationPolicy {
  constructor(private readonly registry: AgentRegistry) {}

  authorize(actor: string, target: string): Authorization {
    const parent = this.registry.get(actor);
    if (!this.registry.has(target)) {
      return deny("UNKNOWN_TARGET", `unknown delegation target \`${target}\``);
    }
    if (!parent.delegatesTo.includes(target)) {
      return deny(
        "DELEGATION_NOT_ALLOWED",
        `\`${actor}\` cannot delegate to \`${target}\``,
      );
    }
    return ALLOW;
  }
}
