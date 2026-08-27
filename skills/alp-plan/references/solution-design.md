# Thiết kế giải pháp

## Nguyên tắc nền

**YAGNI** — không thêm cho tới khi thật sự cần.
**KISS** — chọn cách đơn giản, kể cả khi cách phức tạp trông thông minh hơn.
**DRY** — không nhân bản. Nhân bản dữ liệu rồi để nó lệch nhau là dạng nợ đắt nhất.

Ba nguyên tắc này là luật thành văn của repo, không phải khuyến nghị.

## So sánh phương án

**Một phương án duy nhất không phải lựa chọn.** Nêu ít nhất hai, kèm bảng:

| Phương án | Hợp khi | Đánh đổi | Chi phí đảo ngược |
|---|---|---|---|
| A | … | … | … |
| B | … | … | … |

Cột **chi phí đảo ngược** quan trọng nhất và hay bị bỏ: một quyết định sai mà đảo lại rẻ
thì cứ chọn và đi tiếp; một quyết định sai mà đảo lại đắt thì đáng mở một lượt phản biện
trước.

Cân: ngắn hạn và dài hạn · độ phức tạp và khả năng bảo trì · công sức và lợi ích thật.

## Bảo mật — nghĩ ở pha thiết kế, không để tới pha review

- Ai được làm gì, kiểm ở đâu.
- Dữ liệu nhạy cảm đi qua đâu, lưu ở đâu, ai đọc được.
- Input từ ngoài được kiểm ở ranh giới nào.
- Secret quản lý thế nào — biến môi trường, không phải file trong repo.
- Với API: giới hạn tần suất, CORS, xác thực.

Lỗ bảo mật phát hiện lúc thiết kế tốn một dòng sửa trong plan. Phát hiện sau khi triển
khai tốn một phase.

## Hiệu năng và quy mô

- Nút thắt tiềm tàng nằm ở đâu — nói cụ thể, không nói "cần tối ưu".
- Truy vấn nào có nguy cơ N+1.
- Chỗ nào đáng cache, và cache mất hiệu lực khi nào.
- Tài nguyên: bộ nhớ, CPU, mạng.

**Quy mô thật của alp-code là 8 vai và một principal.** Thiết kế cho hàng trăm agent là
over-engineering ở đây. Dùng `alp-predict` hoặc kỹ thuật quy mô của `problem-solving` để
kiểm cả chiều nhỏ, không chỉ chiều lớn.

## Edge case và failure mode

Phase nào không nêu được failure mode thì **chưa duyệt được**. Bắt buộc trả lời:

- Hỏng ở đâu, và hỏng thì lan tới đâu?
- Hỏng một phần thì trạng thái còn nhất quán không?
- Có cần retry / fallback không? Retry có gây hại gì không?
- Có race condition không?
- Xuống cấp có kiểm soát trông như thế nào?

alp-code chọn **fail đóng**: hỏng thì hỏng to và thấy ngay. Thiết kế nào hỏng im lặng là
thiết kế sai ở repo này — compiled policy invariants và cả `doctor.cjs` đều dựng trên nguyên tắc đó.

## Kiến trúc

- Ranh giới module: cái gì thuộc về đâu, và **vì sao**.
- Chiều phụ thuộc: ai được biết về ai. Phụ thuộc vòng là dấu hiệu ranh giới sai.
- Dòng dữ liệu: vào đâu, biến đổi ở đâu, ra đâu.
- Cái gì là **nguồn sự thật**, cái gì là **sản phẩm sinh ra**. Nhầm hai loại này là lớp
  bug đắt nhất trong alp-code — `compiled AgentDefinition` là nguồn, `~/.alp/executions/**` là sản phẩm.
- Trạng thái giữ ở đâu, và ai được sửa.

## Quy tắc

- **Ghi lý do quyết định**, không chỉ ghi quyết định. Sáu tháng sau `git log` cho biết đã
  làm gì; chỉ plan mới cho biết vì sao.
- Thiết kế kèm cách kiểm chứng — không kiểm được thì không đóng được phase.
- Nghĩ tới cả cách quan sát lúc chạy: hỏng thì nhìn vào đâu để biết.
- Nghĩ tới cách quay lui: triển khai xong mà sai thì lùi bằng cách nào.
