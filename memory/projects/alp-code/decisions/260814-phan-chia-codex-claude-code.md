---
name: phan-chia-codex-claude-code
type: decision
created: 2026-08-14
updated: 2026-08-14
---

# Codex và Claude Code chạy song song, chia theo loại việc

## Bối cảnh
Máy Phúc Anh có sẵn hai runtime agent: Claude Code (phiên của Phở, model mặc định `opus`) và
Codex CLI 0.147.0 (đã login, ba model GPT-5.6). Câu hỏi không phải "cái nào mạnh hơn" mà
"việc nào đi đường nào" — thiếu luật thì mỗi phiên Phở lại tự quyết một kiểu.

## Quyết định
Hai runtime chạy **song song, độc lập**. Ranh giới:

> **Codex** → nghiên cứu sâu, và khi cần phương án sáng tạo hơn.
> **Claude Code** → mọi việc còn lại.

Chia theo **loại việc, không theo độ khó**. Một bài khó thuộc loại thực thi vẫn ở Claude Code;
một câu hỏi dễ nhưng cần đào sâu vẫn sang Codex.

Chi tiết định tuyến + bảng model: `docs/model-routing.md`.

## Vì sao chia thế này
Codex không mạnh hơn — nó **sai khác đi**. Prior khác nghĩa là hướng tiếp cận khác, và đó
đúng là thứ cần khi đào sâu hoặc khi đang bí. Ngược lại, việc thực thi cần bối cảnh liên tục
và công cụ tại chỗ; Claude Code giữ cả hai, Codex thì không — nó là tiến trình rời, không
thấy context phiên Phở.

Hướng dẫn của chính OpenAI khớp với ranh giới này: họ mô tả Sol cho "việc mơ hồ, khó, giá trị
cao, cần thêm phân tích và phán đoán", nêu đích danh **deep research**.

## Ngân sách
- **Codex Sol: cứ dùng**, không hỏi lại từng lần — nghiên cứu sâu vốn đáng tiền.
- **Fable 5: hỏi trước mỗi lần**, kèm lý do vì sao Opus 5 không đủ. Câu hỏi rỗng lặp lại
  nhiều lần sẽ thành thủ tục, đúng thứ luật duyệt sinh ra để tránh.

## Nguồn tra cứu
Thông tin Codex **ưu tiên document OpenAI**, không dùng blog bên thứ ba. Đây không phải sở
thích — bản đầu `docs/model-routing.md` lấy giá Terra/Luna từ blog và **sai**: blog ghi
Terra 2.50/15 và Luna 1/6 (giá ra mắt), docs OpenAI cho 2.00/12 và 0.20/1.20. Lệch tới 80%
ở Luna. Trang công bố GPT-5.6 của OpenAI cũng vẫn để giá ra mắt — chỉ trang pricing là đúng.

## Hệ quả
- `USER.md` — thêm 3 ràng buộc lặp lại: luật phân chia, nguồn OpenAI, ngân sách.
- `TOOLS.md` §2 — thay mục "chọn model" bằng luật phân chia; §4 xếp `Agent(model: "fable")`
  vào nhóm **phải hỏi trước mỗi lần**, cạnh `git push` và `herdr agent start`.
- Prompt gửi Codex phải **tự đủ bối cảnh** (mục tiêu, đường dẫn, cái đã thử, định dạng out).
- Luật kiểm chứng ở `AGENTS.md` không có ngoại lệ cho vendor khác: kết quả Codex vẫn phải
  Phở đọc lại bằng mắt mình trước khi báo cáo lên.

## Ràng buộc kỹ thuật đã phát hiện
`Agent` tool chỉ nhận `model` ∈ `opus` · `sonnet` · `haiku` · `fable`. Không spawn được
subagent trên một model ID cụ thể (Opus 4.8, Sonnet 4.6…) — muốn thế phải đi qua API hoặc Codex.

Liên quan: [[herdr-lam-lop-fleet]]
