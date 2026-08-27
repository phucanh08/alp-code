# Chuẩn đầu ra

## Frontmatter của `plan.md`

Sáu trường, không hơn. Repo này đã dùng đúng bộ này — xem
`plans/260821-0930-multi-agent-identity-memory/plan.md`.

```yaml
---
status: draft | in-progress | completed | cancelled
created: YYYY-MM-DD
slug: <kebab>
source: plans/reports/<report>.md
blockedBy: []
blocks: []
---
```

| Trường | Điền thế nào |
|---|---|
| `status` | kế hoạch mới luôn là `draft` cho tới khi principal duyệt |
| `created` | ngày hôm nay, `YYYY-MM-DD` |
| `slug` | trùng phần slug của tên thư mục |
| `source` | report sinh ra kế hoạch này. Không có thì bỏ trường |
| `blockedBy` / `blocks` | phát hiện lúc quét trước khi tạo — `[]` nếu không có |

**Không thêm trường.** `priority`, `effort`, `tags`, `branch`, `issue` là của bản gốc
alp-plugin — chúng chỉ có nghĩa khi có dashboard đọc chúng. alp-code không có, nên thêm vào
là dữ liệu không ai cập nhật rồi trôi lệch.

## Chia phase

- Mỗi phase **chạy được độc lập** sau khi phase phụ thuộc xong. Phase phải mở ba file mới
  chạy nổi thì đó là hai phase.
- Xếp theo **phụ thuộc và rủi ro**, không theo mức dễ. Phần rủi ro cao đi trước — biết sớm
  rẻ hơn biết muộn.
- Phase nào có spike quyết kiến trúc thì đặt trước, và ghi rõ: kết quả spike có thể đổi
  phase sau.
- Mỗi phase phải có **lệnh chạy được** làm tiêu chí hoàn thành.

## File đụng tới

Liệt kê kèm:

- Đường dẫn **từ gốc repo** (`scripts/lib/loadout.cjs`), không phải đường dẫn tương đối
  theo chỗ đang đứng.
- Hành động: sửa / tạo / xoá.
- Một câu đổi gì.
- Phụ thuộc vào thay đổi nào khác.

Hai loại file **không bao giờ đưa vào danh sách sửa**:

| Loại | Vì sao |
|---|---|
| `~/.alp/executions/**`, `$CODEX_HOME/*.config.toml` | sản phẩm của `npm run build`. Sửa tay là mất ở lần compile sau |
| `compiled policy invariants`, `src/agents/shared/**`, `src/agents/registry.ts` | chỉ principal sửa (compiled policy invariants) |

Kế hoạch cần đổi chúng thì ghi vào mục **Cần principal duyệt**, đừng ghi vào danh sách việc.

## Văn phong

Hy sinh ngữ pháp cho cô đọng. Gạch đầu dòng và bảng. Câu ngắn. Bỏ từ thừa.

Viết cho một vai khác đọc và **làm được mà không hỏi lại**. Chỗ nào phải hỏi lại thì chỗ đó
chưa viết xong.

Trong plan, nói **vì sao chọn cách này** ở chỗ quyết định không hiển nhiên. Sáu tháng sau,
`git log` cho biết đã làm gì; chỉ plan mới cho biết vì sao.

## Câu hỏi còn mở

**Luôn có mục này ở cuối `plan.md`**, kể cả khi rỗng (ghi "không").

Đưa vào đây: chỗ cần principal làm rõ, quyết định kỹ thuật cần người quyết, ẩn số ảnh
hưởng cách triển khai, đánh đổi cần quyết định nghiệp vụ.

Hỏi thẳng trong phiên — không có `AskUserQuestion`, và cũng không cần. Có câu trả lời thì
sửa lại plan và phase.

## Chất lượng

- **Đủ sâu:** nêu edge case và failure mode. Phase chưa nêu được failure mode thì chưa
  duyệt được.
- **Bền:** ghi lý do quyết định. Tránh over-engineering — YAGNI áp dụng cho kế hoạch trước
  khi áp dụng cho code.
- **Có căn cứ:** không chắc thì giao đi một lượt tra cứu, đừng đoán rồi viết như thật.
- **Bảo mật và hiệu năng:** nêu ngay ở phase liên quan, không dồn vào một phase "review"
  cuối.
- **Khớp repo:** đối chiếu với mẫu đang có. Kế hoạch đúng kỹ thuật nhưng lệch quy ước thì
  vẫn phải làm lại.

## Không làm

- **Không viết code trong lúc lập kế hoạch.** Ra plan, principal duyệt, rồi mới làm.
- Không tạo plan hay report ngoài `plans/` của repo này.
- Trả về **đường dẫn plan + tóm tắt**, không dán cả nội dung plan vào câu trả lời.
