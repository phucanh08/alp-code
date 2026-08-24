const fs = require("fs");
const path = require("path");
const L = require("../../loadout.cjs");
const { InvalidConfiguration } = require("./errors.cjs");

class DelegationContextBuilder {
  constructor(options) {
    this.repoRoot = options.repoRoot;
    this.buildRoleContext = options.buildRoleContext;
  }

  build({ parent, target, task, workspace, inputContext }) {
    const resolved = path.resolve(workspace || this.repoRoot);
    const cwd = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())
      throw new InvalidConfiguration(`Workspace không tồn tại: ${cwd}`);

    const targetWorkspaces = L.effectiveWorkspaces(target);
    const isAlpHome = L.isWithin(this.repoRoot, cwd);
    // Backward compatibility: cwd lạ vẫn được mở ở mức read-only; chỉ workspaces.write
    // mới nâng quyền. Đây cũng là contract của `alp` không tham số.
    const canWrite = target.role === "main" && (
      isAlpHome || targetWorkspaces.write.some((root) => L.isWithin(root, cwd))
    );
    const roleContext = this.buildRoleContext
      ? this.buildRoleContext(this.repoRoot, target.role, { workspace: cwd })
      : "";

    return {
      parentRole: parent.role,
      targetRole: target.role,
      workspace: cwd,
      sandbox: canWrite ? "workspace-write" : "read-only",
      roleContext,
      prompt: wrapDelegatedPrompt(task, parent, target, inputContext, cwd),
    };
  }
}

function wrapDelegatedPrompt(
  task,
  parent = { role: "main", name: "Phở", emoji: "🍜" },
  target = {},
  inputContext = null,
  workspace = null
) {
  const parentName = [parent.name, parent.emoji].filter(Boolean).join(" ") || parent.role;
  const principalFacing = parent.role === "principal" && target.role === "main";
  const sections = [
    "# NGUỒN ỦY NHIỆM",
    "",
    `Nhiệm vụ này do \`${parent.role}\` (${parentName}) giao qua ALP Delegation API đã duyệt.`,
    `Bạn đang thực thi role \`${target.role || "được chỉ định"}\`.`,
    principalFacing
      ? "Trao đổi và trả kết quả trực tiếp cho principal."
      : `Kết quả lifecycle của execution này trả về \`${parent.role}\`. Nếu principal tương tác trực tiếp, hãy trao đổi và trả lời principal trực tiếp.`,
    "Kênh giao tiếp không thay đổi ACL, delegates_to hay quyền memory/workspace.",
    "Không gọi trực tiếp runtime-specific delegation command, create_agent hoặc spawn_agent.",
    "ALP đã quyết định role, ACL, memory visibility và context cho execution này.",
    ...(workspace ? [
      "",
      "# WORKSPACE CỦA EXECUTION",
      "",
      workspace,
      "Đây là source workspace duy nhất của nhiệm vụ này. Không dùng code, cache hay kết quả từ workspace khác đã đăng ký, trừ khi nhiệm vụ ghi rõ cần cross-project.",
      "Trước khi kết luận, xác minh mọi path bằng chứng đều nằm dưới workspace này.",
    ] : []),
    "",
    "# NHIỆM VỤ",
    "",
    task,
  ];
  if (inputContext !== null && inputContext !== undefined) {
    sections.push(
      "",
      "# BỐI CẢNH BỔ SUNG DO ALP CUNG CẤP",
      "",
      typeof inputContext === "string" ? inputContext : JSON.stringify(inputContext, null, 2)
    );
  }
  return sections.join("\n");
}

function delegatedPromptPointer(file, parentRole = "main", targetRole = null) {
  const parentName = parentRole === "main" ? " (Phở 🍜)" : "";
  const communication = parentRole === "principal"
    ? "Trao đổi và trả kết quả trực tiếp cho principal. "
    : `Kết quả execution trả về \`${parentRole}\`; nếu principal tương tác trực tiếp thì trả lời principal trực tiếp. `;
  return (
    `Nhiệm vụ này do \`${parentRole}\`${parentName} giao qua ALP Delegation API đã duyệt. ` +
    communication +
    "Không gọi trực tiếp runtime delegation tool. " +
    `Nội dung nhiệm vụ nằm trong ${file} — đọc file đó trước, rồi làm đúng nội dung trong đó.`
  );
}

module.exports = { DelegationContextBuilder, wrapDelegatedPrompt, delegatedPromptPointer };
