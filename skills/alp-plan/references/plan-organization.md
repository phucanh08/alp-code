# Tổ chức file kế hoạch

## Đường dẫn

```
plans/{YYMMDD}-{HHMM}-{slug}/
  plan.md
  phase-0-<tên>.md
  phase-1-<tên>.md
  ...
```

Báo cáo: `plans/reports/{loại}-{YYMMDD}-{HHMM}-{slug}.md`
(`loại` = `brainstorm`, `research`, `review`, `skills`… — tên vai hoặc loại báo cáo).

`{YYMMDD}-{HHMM}` lấy lúc **bắt đầu** kế hoạch, không đổi về sau. Slug là kebab, mô tả
được, không đánh số.

Ví dụ thật trong repo: `plans/260821-0930-multi-agent-identity-memory/`.

**Không có hook nào inject đường dẫn.** Tự tính từ ngày giờ hiện tại.

## `plan.md`

Frontmatter bắt buộc:

```yaml
---
status: draft | in-progress | completed | cancelled
created: YYYY-MM-DD
slug: <kebab>
source: plans/reports/<report sinh ra kế hoạch này>.md
blockedBy: []
blocks: []
---
```

Thân, theo đúng thứ tự này:

```markdown
# <Tiêu đề>

## Tổng quan

<2–5 câu: xây cái gì, cho ai, thay thế cái gì.>

Nguồn sự thật: [<report>](../reports/<file>.md).

**Ngoài phạm vi:** <liệt kê thẳng. Cái gì để lại cho sau, cái gì cố tình không làm.>

## Nguyên tắc bất biến

1. **<Nguyên tắc>.** <Vì sao. Vi phạm thì hỏng thế nào.>

## Phase

| Phase | Tên | Trạng thái |
|---|---|---|
| 0 | [Dựng khung](./phase-0-scaffold.md) | chưa làm |
| 1 | [ACL](./phase-1-loadout-acl.md) | chưa làm |
```

Giữ `plan.md` **dưới 80 dòng**. Nó là cửa vào, không phải nơi chứa chi tiết.

Hai mục hay bị bỏ và đều đắt khi bỏ:

- **Ngoài phạm vi** — không có thì phạm vi tự phình trong lúc làm, và không ai chỉ ra được
  lúc nào nó bắt đầu phình.
- **Nguyên tắc bất biến** — cái neo để phase sau không mâu thuẫn phase trước.

Text của link phải là **tên người đọc được**, không phải tên file:
`[Dựng khung](./phase-0-scaffold.md)`, không phải `[phase-0-scaffold.md](...)`.

## File phase

Mở đầu bắt buộc:

```markdown
# P<n> — <tên>

**Mục tiêu:** <một câu. Xong phase này thì cái gì đúng mà trước đó chưa đúng.>
**Phụ thuộc:** <P trước đó, hoặc "không">

---
```

Rồi các mục theo nhu cầu — **chỉ viết mục nào có nội dung thật**:

| Mục | Khi nào cần |
|---|---|
| Bối cảnh | dẫn report, file, tài liệu liên quan |
| Việc phải làm | các bước đánh số, cụ thể tới tên file và tên hàm |
| File đụng tới | sửa gì, tạo gì, xoá gì |
| **Tiêu chí hoàn thành** | **luôn luôn** — lệnh chạy được để chứng minh phase xong |
| Rủi ro | failure mode + cách giảm thiểu |
| Cần principal duyệt | thao tác khó đảo ngược trong phase này |

**Không có tiêu chí hoàn thành thì phase không bao giờ đóng được.** Tiêu chí phải là thứ
chạy được: `node scripts/doctor.cjs` sạch, `test-x.cjs` xanh — không phải "hoạt động tốt".

Phase có spike (thử nghiệm để quyết kiến trúc) thì ghi thẳng: **không viết code phần sau
trước khi spike xong**, vì kết quả spike có thể đổi cả phase kế tiếp.

## Quan hệ giữa các kế hoạch

Ghi vào frontmatter `blockedBy`/`blocks`, dùng tên thư mục kế hoạch.

**Cập nhật cả hai file.** Ghi một chiều thì lần quét sau chỉ thấy một nửa.

Có quan hệ chặn thì thêm bảng vào `plan.md`:

```markdown
## Phụ thuộc kế hoạch khác

| Quan hệ | Kế hoạch | Trạng thái |
|---|---|---|
| Chặn | [<tên>](../<dir>/plan.md) | in-progress |
```

## Không có trong alp-code

Bản gốc của skill này giả định vài thứ repo này không có — bỏ qua nếu gặp trong tài liệu cũ:

| Không có | Thay bằng |
|---|---|
| `ck plan create` CLI | viết file trực tiếp bằng `Write` |
| task hydration (`TaskCreate`) | không có hệ task; `plan.md` là nguồn sự thật duy nhất |
| `set-active-plan.cjs` | không có khái niệm "kế hoạch đang hoạt động" |
| hook inject `## Naming` / `## Plan Context` | tự tính đường dẫn |
