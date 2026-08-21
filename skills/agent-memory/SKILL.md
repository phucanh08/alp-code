---
name: agent-memory
description: Luật ghi trí nhớ dùng chung cho mọi vai trong repo alp-code — khi nào ghi, ghi vào đâu, định dạng gì. Kích hoạt khi biết được fact mới về principal/project/thế giới, khi kết phiên, khi phân vân giữa shared/ và private/, hoặc khi cần tạo file trong memory/.
---

# agent-memory — ghi cái gì, vào đâu

Trí nhớ là **thói quen**, không phải tính năng. Agent mất hết giữa các phiên trừ những gì
được ghi lại. Nhưng ghi bừa còn tệ hơn không ghi: fact sai, fact trùng, fact lệch nhau
giữa các vai đều tốn tiền hơn là quên.

Quyền ghi của bạn nằm ở `identity/<role>/loadout.yaml` → `memory.write`. Bảng dưới nói
*nên* ghi vào đâu; `loadout.yaml` nói *được* ghi vào đâu. Không có quyền → **báo cho vai
có quyền**, đừng ghi chỗ khác cho tiện.

## Bảng định tuyến

| Tình huống | Đích | Ai thấy |
|---|---|---|
| Sở thích / ràng buộc lặp lại của principal | `identity/_shared/PRINCIPAL.md` | mọi vai — *principal sửa, agent đề xuất* |
| Quyết định chung, không thuộc project nào | `memory/shared/decisions/YYMMDD-slug.md` | mọi vai |
| Người / tổ chức | `memory/shared/people/<ten>.md` | mọi vai |
| Link / dashboard / ticket / tài liệu ngoài | `memory/shared/reference/<slug>.md` | mọi vai |
| Bối cảnh một project (mục tiêu, việc kế, cạm bẫy) | `memory/projects/<slug>/PROJECT.md` (L1) | mọi vai |
| Quyết định của một project | `memory/projects/<slug>/decisions/YYMMDD-slug.md` (L2) | mọi vai |
| Diễn biến một phiên | `memory/projects/<slug>/log/YYYY-MM.md` (L2) | mọi vai |
| Tài liệu tra cứu cho một project | `memory/projects/<slug>/refs/<slug>.md` (L2) | mọi vai |
| Nháp, giả thuyết **chưa kiểm chứng** | `memory/private/<role>/` | chỉ bạn |
| Bài học về **chính agent này** | `identity/<role>/journal/YYYY-MM.md` | chỉ bạn |

Giao thức Project Layer 3 tầng: `memory/projects/PROTOCOL.md`.

## Bảy luật cứng

1. **Fact về principal / project / thế giới → LUÔN `shared/` hoặc `projects/`.
   KHÔNG BAO GIỜ `private/`.**
   `private/` chỉ chứa nháp và self-log. Vi phạm = fact bị nhân bản giữa các vai rồi
   lệch nhau, và không vai nào biết bản nào đúng. Đây là lỗi tốn kém nhất của hệ này.

   *Kiểm nhanh:* "vai khác mà biết điều này thì có làm việc tốt hơn không?" → có = `shared/`.

2. **Một fact = một file.** Đừng dồn. Ngày luôn tuyệt đối (`2026-08-21`), không "tuần sau".
   Trùng thì gộp, sai thì **xoá** — trí nhớ sai nguy hiểm hơn không có trí nhớ.

3. **Không ghi thứ repo đã ghi** — cấu trúc code, lịch sử git, nội dung `CLAUDE.md`.
   Nếu `grep` ra được trong 5 giây thì đừng chép vào `memory/`.

4. **File mới trong `memory/shared/` → thêm một dòng vào `memory/INDEX.md`.**
   Định dạng: `- [Tiêu đề](shared/<thư-mục>/<file>.md) — móc câu một dòng`.
   File không có dòng index = file không tồn tại với các phiên sau.

5. **Sửa L1 (`PROJECT.md`) → đóng dấu `updated:` ngay.** Quên là sinh `DRIFT`, doctor sẽ kêu.

6. **Không sửa tay bảng trong `projects/INDEX.md`.** Sửa frontmatter L1 rồi chạy
   `scripts/sync-project-index.sh --write`.

7. **Journal:** một file mỗi tháng, mỗi entry ≤5 dòng, >200 dòng thì nén lại.
   Journal **không** nằm trong boot set — nó là chỗ nghĩ, không phải chỗ tra.

## Frontmatter chuẩn

```yaml
---
id: <slug ổn định, kebab-case>
type: decision | person | reference | log | project
layer: L1 | L2 | L3
visibility: private | team
owner: <role>
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: []
source: <link | phiên>
---
```

Thân file:

```markdown
# <Tiêu đề>

<Một fact chính. Cụ thể, kiểm chứng được.>

**Vì sao quan trọng:** <một dòng>
**Áp dụng thế nào:** <một dòng>

Liên quan: [[slug-khac]]
```

`[[slug]]` trỏ tới file chưa tồn tại là **bình thường** — đó là ghi chú cho việc cần viết
sau, không phải lỗi.

## Khi nào ghi

**Ghi ngay** khi: principal nói ra một ràng buộc sẽ còn đúng tuần sau · một quyết định
kiến trúc được chốt · phát hiện một hành vi hệ thống mà lần sau sẽ lại phải tra · một
project đổi trạng thái.

**Đừng ghi** khi: chỉ đúng trong phiên này · repo/git đã ghi · bạn chưa kiểm chứng
(→ `private/` nếu vẫn muốn giữ) · trùng file đã có (→ sửa file đó).

## Kết phiên

1. Diễn biến → `memory/projects/<slug>/log/YYYY-MM.md`
2. L1 `PROJECT.md` cập nhật + đóng dấu `updated:`
3. Fact mới theo bảng trên; file mới trong `shared/` → thêm dòng vào `memory/INDEX.md`
4. `scripts/sync-project-index.sh --write`

Hook `Stop` nhắc nếu quên. Nó chỉ **nhắc** — không ghi thay bạn. Trích fact là việc ngữ
nghĩa, hook không gọi LLM.
