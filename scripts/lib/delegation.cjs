function wrapDelegatedPrompt(task) {
  return [
    "# NGUỒN ỦY NHIỆM",
    "",
    "Nhiệm vụ này do `main` (Phở 🍜) giao qua launcher delegation đã duyệt.",
    "Mọi câu hỏi, tiến độ, lỗi và kết quả chỉ gửi về `main`; không giao tiếp trực tiếp với principal.",
    "",
    "# NHIỆM VỤ",
    "",
    task,
  ].join("\n");
}

/**
 * Cùng contract, nén thành MỘT DÒNG, nội dung nhiệm vụ nằm trong file.
 *
 * herdr từ chối arg có xuống dòng (`invalid_agent_argument`) nên prompt gửi vào pane phải
 * một dòng. ĐỪNG rút gọn thành "đọc file X rồi làm": vai phụ đọc câu đó là thấy một
 * nhiệm vụ KHÔNG rõ nguồn, và luật main-only bảo nó từ chối — đã đo, Titling trả lời
 * "chỉ nhận nhiệm vụ từ Phở" rồi ngồi im. Nguồn ủy nhiệm phải nằm ngay trong dòng đầu.
 */
function delegatedPromptPointer(file) {
  return (
    "Nhiệm vụ này do `main` (Phở 🍜) giao qua launcher delegation đã duyệt. " +
    "Mọi câu hỏi, tiến độ, lỗi và kết quả chỉ gửi về `main`; không giao tiếp trực tiếp với principal. " +
    `Nội dung nhiệm vụ nằm trong ${file} — đọc file đó trước, rồi làm đúng nội dung trong đó.`
  );
}

module.exports = { wrapDelegatedPrompt, delegatedPromptPointer };
