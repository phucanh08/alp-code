# Phương pháp điều tra mức hệ

Năm bước cho sự cố nhiều thành phần — khác với gỡ một bug trong code, ở đây bạn phải dựng
lại **chuyện gì đã xảy ra** trước khi bàn tới sửa gì.

## Khi nào dùng

- Server trả 500 hoặc phản hồi lạ.
- Hành vi hệ đổi mà không thấy code đổi.
- Sự cố trải qua nhiều dịch vụ / database / hạ tầng.
- Cần biết "đã xảy ra chuyện gì" trước khi bàn cách sửa.

## Bước 1 — Đánh giá ban đầu

Nắm phạm vi và mức ảnh hưởng **trước khi** lao vào chi tiết.

1. **Gom triệu chứng** — thông báo lỗi, endpoint bị ảnh hưởng, mô tả của principal.
2. **Xác định thành phần liên quan** — dịch vụ nào, database nào, hàng đợi nào.
3. **Khoanh mốc thời gian** — bắt đầu từ khi nào? Trùng với deploy hay thay đổi nào?
4. **Đánh giá mức nghiêm trọng** — ảnh hưởng ai, dữ liệu có rủi ro không.
5. **Xem gì vừa đổi.**

```bash
gh run list --limit 10
git log --oneline -20 --since="2 days ago"
git diff HEAD~5 -- '*.env*' '*.config*' '*.yml' '*.yaml' '*.json'
```

Bước 5 giải quyết một tỷ lệ lớn sự cố ngay tại chỗ. Làm trước khi làm gì phức tạp hơn.

## Bước 2 — Thu thập dữ liệu

Gom bằng chứng **có hệ thống**, trước khi phân tích. Vừa gom vừa suy diễn dẫn tới việc chỉ
gom thứ khớp với giả thuyết đầu tiên.

1. **Log ứng dụng / server** — lọc theo mốc thời gian và thành phần.
2. **Log CI/CD** — xem `log-and-ci-analysis.md`.
3. **Trạng thái database** — truy vấn bảng liên quan, kiểm migration gần đây.
4. **Số đo hệ thống** — CPU, bộ nhớ, đĩa, mạng.
5. **Phụ thuộc bên ngoài** — API bên thứ ba, DNS, CDN.

```bash
gh run list --workflow=<workflow> --limit 5
gh run view <run-id> --log-failed
gh run view <run-id> --log > /tmp/ci-logs.txt
```

**Cần hiểu codebase lạ:** báo lại để nhờ một lượt truy xuất code hoặc tra tài liệu ngoài.
Loadout không cho giao việc thì đừng tự đi làm phần đó.

## Bước 3 — Phân tích

Đối chiếu chéo giữa các nguồn.

1. **Dựng lại mốc thời gian** — xếp sự kiện theo thứ tự, gộp mọi nguồn log.
2. **Nhận mẫu** — lỗi lặp lại, mẫu theo thời điểm, nhóm người dùng bị ảnh hưởng.
3. **Lần đường thực thi** — request đi qua những thành phần nào.
4. **Phân tích database** — hiệu năng truy vấn, quan hệ bảng, toàn vẹn dữ liệu.
5. **Vẽ phụ thuộc** — thành phần nào phụ thuộc thành phần đang hỏng.

Bốn câu hỏi then chốt:

- Có trùng với một lần deploy hay một khung giờ cụ thể không?
- Xảy ra lúc có lúc không, hay luôn luôn?
- Ảnh hưởng mọi người dùng hay một nhóm?
- Dịch vụ phía trước / phía sau có lỗi liên quan không?

## Bước 4 — Xác định nguyên nhân gốc

Loại trừ có hệ thống, bằng bằng chứng.

1. **Liệt kê giả thuyết**, xếp theo độ mạnh của bằng chứng.
2. **Thử từng cái** — thí nghiệm nhỏ nhất đủ để xác nhận hoặc loại bỏ.
3. **Xác nhận bằng bằng chứng** — log, số đo, bước tái hiện.
4. **Xét yếu tố môi trường** — race condition, giới hạn tài nguyên, config trôi lệch.
5. **Ghi lại cả chuỗi** — từ chỗ kích hoạt tới triệu chứng.

**Tránh:** sửa theo giả thuyết đầu tiên mà chưa thử các giả thuyết khác. Nhiều nguyên nhân
đều hợp lý thì phải loại trừ, không phải chọn cái tiện nhất.

Ghi rõ giả thuyết nào **đã bị bác và bằng gì** — không có phần đó, người đọc sẽ đi lại đúng con
đường bạn vừa đi.

## Bước 5 — Đề xuất phương án

Bạn đề xuất, người khác thực hiện. Tách rõ ba loại:

| Loại | Nội dung |
|---|---|
| **Ngay** | thay đổi nhỏ nhất để khôi phục — hotfix, rollback, đổi config |
| **Gốc** | xử lý dứt điểm nguyên nhân gốc |
| **Phòng ngừa** | giám sát, cảnh báo, chốt chặn để lần sau phát hiện sớm |

Thứ tự ưu tiên: **ảnh hưởng × mức khẩn**. Khôi phục trước, sửa gốc sau, phòng ngừa sau nữa.

Đánh dấu rõ phương án nào là thao tác **khó đảo ngược** (rollback production, migration,
xoá dữ liệu) — phải xin principal duyệt trước khi chạy (HOUSE-RULES §1.2).

## Khi thu hẹp được về code cụ thể

| Chuyển sang | Khi |
|---|---|
| `systematic-debugging.md` | đã khoanh về một vùng code |
| `root-cause-tracing.md` | lỗi nổ sâu trong call stack |
| `defense-in-depth.md` | đã ra nguyên nhân, cần khuyến nghị chốt chặn |
| `verification.md` | trước khi phát biểu kết luận |
