# Phân tích log và CI/CD

## GitHub Actions

```bash
gh run list --limit 10                    # các lần chạy gần đây
gh run list --workflow=ci.yml --limit 5   # theo workflow
gh run view <run-id>                      # chi tiết, trạng thái từng bước
gh run view <run-id> --log-failed         # CHỈ log của job hỏng — bắt đầu ở đây
gh run view <run-id> --log > /tmp/ci.txt  # tải hết
```

Luôn bắt đầu bằng `--log-failed`. Tải log đầy đủ trước rồi đọc là cách nhanh nhất để nhấn
chìm context bằng hàng nghìn dòng xanh.

`gh run rerun <run-id> --failed` chạy lại job hỏng — nhưng **đó là thao tác tốn tài nguyên
và tác động ra ngoài**: báo lại, đừng tự chạy để "xem thử có phải flaky không".

### Mẫu hỏng thường gặp

| Mẫu | Nguyên nhân hay gặp | Kiểm gì |
|---|---|---|
| máy chạy được, CI hỏng | khác môi trường | phiên bản Node/Python, OS, biến môi trường |
| lúc hỏng lúc không | race, test flaky | chạy 3 lần, xem thời điểm, trạng thái dùng chung |
| timeout | giới hạn tài nguyên, vòng lặp vô hạn | mức dùng tài nguyên, có timeout chưa |
| lỗi quyền | token/secret sai cấu hình | `GITHUB_TOKEN`, tên secret |
| cài phụ thuộc hỏng | registry, xung đột phiên bản | lockfile, trạng thái registry |
| build được, test hỏng | môi trường test | config test, database, fixture |

Dòng đầu đáng chú ý nhất: **"máy chạy được, CI hỏng" gần như luôn là khác biệt môi
trường**, không phải bug trong code. So biến môi trường trước khi đọc code.

### Đọc bước hỏng

1. `gh run view <id>` — xác định **bước nào** hỏng.
2. `gh run view <id> --log-failed` — lấy log tập trung.
3. Tìm mẫu lỗi: `Error:`, `FAIL`, `exit code`, stack trace.
4. Xem annotation: `gh api repos/{owner}/{repo}/check-runs/{id}/annotations`.

## Log server

### Cách thu

1. **Xác định chỗ chứa log** — log ứng dụng, log hệ thống, log web server.
2. **Lọc theo khung thời gian** của sự cố.
3. **Đối chiếu theo request ID** — lần một request qua nhiều dịch vụ.
4. **Tìm mẫu** — lỗi lặp, tỷ lệ lỗi đổi, payload bất thường.

### Truy vấn database

```bash
# truy vấn chậm
psql -c "SELECT query, calls, mean_exec_time FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;"

# trạng thái kết nối
psql -c "SELECT count(*), state FROM pg_stat_activity GROUP BY state;"
```

Chỉ chạy truy vấn **đọc**. `UPDATE`, `DELETE`, `ALTER` trên database thật là thao tác khó
đảo ngược, phải xin principal duyệt.

### Đối chiếu chéo nguồn

1. **Căn mốc thời gian** giữa mọi nguồn — chú ý múi giờ, đây là chỗ hay sai nhất.
2. **Dựng timeline** — lỗi đầu tiên → lan ra → người dùng thấy.
3. **Tìm chỗ kích hoạt** — cái gì đổi ngay trước lỗi đầu tiên?
4. **Vẽ bán kính ảnh hưởng** — dịch vụ/endpoint nào bị.

## Đọc mẫu lỗi ứng dụng

| Hình dạng | Nghĩa thường là |
|---|---|
| vọt lên đột ngột | deploy, đổi config, phụ thuộc ngoài chết |
| tăng dần | rò tài nguyên, dữ liệu phình, xuống cấp |
| hỏng theo chu kỳ | cron, tác vụ định kỳ, tranh chấp tài nguyên |
| chỉ một endpoint | bug code, vấn đề dữ liệu, một phụ thuộc cụ thể |
| mọi endpoint | hạ tầng, database, mạng |

Hình dạng theo thời gian nói nhiều hơn nội dung một dòng lỗi. Vẽ nó trước khi đọc chi tiết.

### Trường log ưu tiên

mốc thời gian · mức · thông báo lỗi · stack trace · request ID · endpoint · mã phản hồi ·
thời lượng.

## Giữ bằng chứng

Trích **đúng phần cần** cho báo cáo, không dán cả file log:

- Thông báo lỗi và stack trace nguyên văn.
- Mốc thời gian và request ID.
- So sánh trước/sau — trạng thái bình thường và trạng thái lỗi.
- Số lượng và tần suất, không phải tính từ.

"Rất nhiều lỗi timeout" là vô dụng. "412 lỗi timeout trong 5 phút, so với 0 ở khung giờ
trước" thì dùng được.
