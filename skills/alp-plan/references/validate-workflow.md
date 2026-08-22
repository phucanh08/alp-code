# Phỏng vấn kiểm chứng kế hoạch

Hỏi principal những câu hỏi then chốt để kiểm chứng giả định và chốt quyết định — **trước**
khi bắt tay viết code.

Khác với rà đối kháng: rà đối kháng tìm chỗ hỏng trong kế hoạch, phỏng vấn kiểm chứng tìm
chỗ kế hoạch **đang đoán thay principal**.

## 1. Đọc kế hoạch

`plan.md` và toàn bộ `phase-*.md`. Tìm ba thứ:

- **Điểm quyết định** — chỗ có nhiều hướng mà kế hoạch đã chọn một.
- **Giả định** — thứ kế hoạch coi là đúng mà chưa ai xác nhận.
- **Đánh đổi** — chỗ được cái này mất cái kia.

## 2. Rút chủ đề hỏi

`references/validate-question-framework.md`.

## 3. Soạn câu hỏi

Mỗi chủ đề → **một câu hỏi cụ thể, kèm 2–4 phương án**. Đánh dấu phương án bạn đề nghị và
nói vì sao.

**Chỉ hỏi điểm quyết định thật.** Câu hỏi mà bạn tự trả lời được từ code, từ `CHARTER.md`,
hoặc từ quy ước sẵn có thì **đừng hỏi** — đó là đẩy việc ngược về principal.

Ba câu đủ thì hỏi ba. Kế hoạch đơn giản mà hỏi tám câu là làm phiền, không phải cẩn thận.

## 4. Hỏi

Hỏi thẳng trong phiên — không có `AskUserQuestion`, và cũng không cần.

Gom câu hỏi liên quan lại một lượt thay vì hỏi lắt nhắt từng câu.

## 5. Ghi lại

Thêm mục `## Nhật ký kiểm chứng` vào `plan.md`:

```markdown
## Nhật ký kiểm chứng

### Lượt 1 — YYYY-MM-DD

| Câu hỏi | Principal chọn | Ảnh hưởng |
|---|---|---|
| <câu hỏi> | <đáp án> | <phase nào phải sửa> |
```

Ghi lại là bắt buộc, không phải tuỳ chọn: CHARTER §2.3 — markdown là source of truth. Câu
trả lời chỉ nằm trong context phiên thì phiên sau mất sạch.

## 6. Lan quyết định xuống phase

Sửa các `phase-*.md` bị ảnh hưởng, kèm dấu:

```markdown
<!-- Sửa: kiểm chứng lượt N — <đổi gì> -->
```

Bước này hay bị bỏ, và bỏ thì hỏng nặng: `plan.md` ghi một đằng, phase ghi một nẻo, và
người thực thi đọc phase chứ không đọc `plan.md`.

## Đầu ra

```
Kiểm chứng: <đường dẫn kế hoạch>
Đã hỏi: n câu
Quyết định đã chốt: <tóm tắt>
Phase đã sửa: <danh sách>
Khuyến nghị: tiến hành | sửa lại kế hoạch
```

## Bước sau

Báo principal đường dẫn kế hoạch và tóm tắt. **Dừng ở đó.**

Kế hoạch được duyệt thì mới triển khai. alp-code không có bước bàn giao sang một vai
"cook" nào cả.

Sang phiên mới để triển khai thì nhớ: phiên mới **không thấy** gì của phiên này. Đường dẫn
kế hoạch phải đưa đầy đủ, và `plan.md` phải tự đứng được một mình.
