import { within } from "../policy/workspace-policy";

/**
 * Một assignment có biên (master plan 2b): cái con *được* ghi, cái con *không được* ghi dù nằm
 * trong phần được ghi, và hai câu chữ đi kèm — mục tiêu và cách nghiệm thu — tách khỏi task
 * để cha không phải trộn chúng vào văn xuôi rồi hy vọng con đọc ra.
 *
 * Mọi đường dẫn ở đây đã canonical (đi qua `authorize()`); phần luật thuần ở dưới không chạm
 * đĩa để `DelegationService` và evidence dùng chung một định nghĩa "chồng lấn".
 */
export interface AssignmentScope {
  readonly workspace: string;
  /** `null` là cả workspace. */
  readonly writeScope: readonly string[] | null;
  /** Các cây con bị loại khỏi phần được ghi; `null` là không loại gì. */
  readonly excludeScope: readonly string[] | null;
}

/** Các gốc con được ghi: scope đã khai, hoặc cả workspace. */
export function ownedRoots(scope: Pick<AssignmentScope, "workspace" | "writeScope">): readonly string[] {
  return scope.writeScope ?? [scope.workspace];
}

/** `path` nằm trọn trong một entry bị loại. */
export function excluded(excludeScope: readonly string[] | null, path: string): boolean {
  return (excludeScope ?? []).some((entry) => within(entry, path));
}

/** `path` nằm trong phần được ghi và không nằm trong phần bị loại. */
export function ownsPath(scope: AssignmentScope, path: string): boolean {
  return ownedRoots(scope).some((root) => within(root, path)) && !excluded(scope.excludeScope, path);
}

/**
 * Vùng hai assignment cùng được ghi — hoặc `null` khi biên của chúng không chạm nhau.
 *
 * Hai gốc chạm nhau khi một gốc nằm trong gốc kia; vùng chung là gốc sâu hơn. Vùng chung
 * không phải xung đột khi một trong hai bên đã *loại* trọn nó: đó chính là cách `--exclude-scope`
 * cho hai con cùng đứng trong `src/` mà không giẫm lên nhau. Loại một phần vùng chung không
 * đủ — phần còn lại vẫn là hai cây bút trên một tờ giấy.
 */
export function sharedRegion(left: AssignmentScope, right: AssignmentScope): string | null {
  if (!within(left.workspace, right.workspace) && !within(right.workspace, left.workspace)) return null;
  for (const a of ownedRoots(left)) {
    for (const b of ownedRoots(right)) {
      const shared = within(a, b) ? b : within(b, a) ? a : null;
      if (shared === null) continue;
      if (excluded(left.excludeScope, shared) || excluded(right.excludeScope, shared)) continue;
      return shared;
    }
  }
  return null;
}

export interface AssignmentText {
  readonly task: string;
  readonly objective: string | null;
  readonly verification: string | null;
  readonly scope: AssignmentScope | null;
}

/**
 * Task con nhận, với assignment là một khối riêng đứng *trước* — mục tiêu, biên, cách
 * nghiệm thu — rồi mới tới task nguyên văn. Không có gì ngoài task thì trả đúng task: mọi
 * lần giao việc trước 2b đọc ra y hệt.
 */
export function renderAssignment(input: AssignmentText): string {
  const lines: string[] = [];
  if (input.objective !== null) lines.push(`Objective: ${input.objective}`);
  if (input.scope !== null) {
    lines.push(`Owned paths (you may write): ${input.scope.writeScope === null ? `the whole workspace \`${input.scope.workspace}\`` : input.scope.writeScope.map((entry) => `\`${entry}\``).join(", ")}`);
    lines.push(`Excluded paths (you may not write, another execution owns them): ${input.scope.excludeScope === null ? "none" : input.scope.excludeScope.map((entry) => `\`${entry}\``).join(", ")}`);
  }
  if (input.verification !== null) lines.push(`Verification (how done is checked): ${input.verification}`);
  if (lines.length === 0) return input.task;
  return [...lines, "", input.task].join("\n");
}
