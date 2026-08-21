---
name: project-layer-3-tang
type: decision
created: 2026-08-14
updated: 2026-08-14
---

# Project Layer dùng 3 tầng progressive disclosure, kiểm soát bằng `modified`

## Bối cảnh
Bản đầu của Phở quản project bằng `projects/REGISTRY.md` + `memory/projects/*.md` — hai tầng,
không metadata, không có gì phát hiện khi thông tin lệch thực tế. Với 3 project thì ổn; với
20 project thì hoặc registry phình ra nuốt context, hoặc nó lặng lẽ sai mà không ai biết.

## Quyết định
Theo mô hình skills system của Hermes Agent: **L0 index → L1 card → L2 refs**, cộng thêm một
lớp kiểm soát bằng hai đồng hồ (`updated:` do Phở đóng dấu, mtime do máy ghi).

## Vì sao
- **L0 rẻ và ổn định.** Một dòng/project, ngày không có giờ → prompt cache sống sót giữa các
  phiên. Hermes giữ cache-hit ~97.5% chính bằng cách này.
- **Lệch thì phải kêu.** Hai đồng hồ so nhau cho ba tín hiệu cơ học (DRIFT/STALE/ORPHAN) —
  không cần Phở "nhớ" kiểm tra, script phát hiện giùm.
- **Một fact một nhà.** Bỏ hẳn `memory/projects/`; mọi thứ thuộc về một project nằm trong
  `projects/<slug>/`. `memory/` chỉ giữ fact xuyên project.

## Đã cân nhắc và loại
- **Một file lớn cho tất cả project** — đơn giản nhất, nhưng nạp toàn bộ mỗi phiên; đúng cái
  cần tránh.
- **Index sinh hoàn toàn tự động từ mtime, bỏ `updated:`** — mất phân biệt giữa "file bị chạm"
  và "Phở đã xác nhận nội dung đúng". Chính khoảng cách giữa hai thứ đó mới là tín hiệu.
- **SQLite / JSON store** — truy vấn tốt hơn nhưng người không đọc được bằng mắt, và mất khả
  năng diff bằng git. Markdown thắng vì Phở lẫn principal đều đọc được.

## Hệ quả
- Thêm project phải qua `_template` + chạy script, không viết tay vào L0.
- Script phụ thuộc BSD `date` (macOS). Chuyển sang Linux thì phải sửa `date -j -f`.
- `updated:` là thao tác thủ công → nếu Phở lười đóng dấu, DRIFT sẽ kêu. Đó là chủ ý.

Liên quan: [[openclaw-architecture]]
