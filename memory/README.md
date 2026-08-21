# memory/ — trí nhớ dùng chung của cả hệ

Mục lục: [`INDEX.md`](INDEX.md). Thư mục này chứa nội dung thật.
Luật ghi đầy đủ: skill `agent-memory`.

## Ba khoang, ba mục đích khác nhau

```
memory/
├── shared/       fact xuyên project — MỌI vai đọc được
│   ├── decisions/   quyết định chung, không thuộc project nào
│   ├── people/      người & tổ chức
│   └── reference/   link, dashboard, ticket, tài liệu ngoài
├── projects/     Project Layer 3 tầng — MỌI vai đọc được, quyền ghi tuỳ vai
│   ├── INDEX.md     L0 — bảng tổng, sinh tự động
│   ├── PROTOCOL.md  giao thức 3 tầng
│   └── <slug>/      L1 PROJECT.md · L2 decisions|log|refs
└── private/      nháp riêng từng vai — CHỈ vai đó đọc được
    └── <role>/
```

## Ranh giới — luật quan trọng nhất của thư mục này

| Loại nội dung | Đích | Vì sao |
|---|---|---|
| Fact về principal | `identity/_shared/PRINCIPAL.md` | một bản duy nhất cho mọi vai |
| Fact xuyên project | `shared/` | mọi vai cần thấy |
| Fact về một project | `projects/<slug>/` | một fact một nhà |
| Nháp, giả thuyết chưa kiểm chứng | `private/<role>/` | chưa đáng tin, đừng lan ra |
| Bài học về chính agent | `identity/<role>/journal/` | không phải fact về thế giới |

**Cấm:** ghi fact về principal / project / thế giới vào `private/`.
Làm vậy = fact bị nhân bản giữa các vai rồi lệch nhau, và không vai nào biết bản nào đúng.
`private/` **chỉ** chứa thứ mà nếu mất đi cũng không ai thiệt.

## Cách ly hai chiều

`private/<role>/` là riêng **thật**. Chief-of-staff **không** đọc được `private/researcher/`
và ngược lại. Không có vai nào là root. Muốn biết vai khác nghĩ gì → hỏi vai đó.

## Định dạng chuẩn mỗi file

```markdown
---
id: <slug-kebab-case>
type: decision | person | reference | log | project
layer: L1 | L2 | L3
visibility: private | team
owner: <role>
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: []
source: <link | phiên>
---

# <Tiêu đề>

<Nội dung. Một fact chính mỗi file.>

**Vì sao quan trọng:** <một dòng>
**Áp dụng thế nào:** <một dòng>

Liên quan: [[slug-khac]]
```

## Luật

- **Một fact = một file.** Đừng dồn.
- **Ngày tuyệt đối.** "tuần sau" → `2026-08-21`.
- **Kiểm tra trùng trước khi tạo.** Có rồi thì cập nhật.
- **Sai thì xoá.** Trí nhớ sai nguy hiểm hơn không nhớ.
- **Không ghi thứ repo đã ghi** — cấu trúc code, lịch sử git, nội dung CLAUDE.md.
- Mỗi file mới trong `shared/` → thêm một dòng vào [`INDEX.md`](INDEX.md).
- Liên kết chéo bằng `[[slug]]`. Link tới file chưa tồn tại là bình thường — ghi chú
  cho việc cần viết sau, không phải lỗi.
