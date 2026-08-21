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

module.exports = { wrapDelegatedPrompt };
