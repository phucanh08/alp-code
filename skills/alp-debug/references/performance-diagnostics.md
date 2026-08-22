# Chẩn đoán hiệu năng

## Khi nào dùng

Thời gian phản hồi tăng rõ rệt · ứng dụng chậm · truy vấn lâu · CPU/bộ nhớ/đĩa cao · cạn
tài nguyên hoặc OOM.

## Luật vào nghề

**Đo trước, tối ưu sau.** Tối ưu mà không có số đo trước là đoán — và thường tối ưu đúng
chỗ không phải nút thắt.

Bốn câu phải trả lời trước khi động vào bất cứ thứ gì:

- Kỳ vọng bao nhiêu, thực tế bao nhiêu? (số cụ thể, không phải "chậm")
- Chậm từ khi nào? Trùng với thay đổi nào?
- Endpoint / thao tác nào bị?
- Luôn luôn hay lúc có lúc không?

## Khoanh tầng nút thắt

```
Request → Mạng → Web server → Ứng dụng → Database → Filesystem
                                 ↓
                          API / dịch vụ ngoài
```

Đo thời gian ở **từng tầng** để biết độ trễ nằm ở đâu. Loại trừ, đừng đoán.

| Tầng | Kiểm | Công cụ |
|---|---|---|
| Mạng | độ trễ, DNS, TLS | `curl -w`, log mạng |
| Web server | hàng đợi request, số kết nối | metric server, access log |
| Ứng dụng | CPU, bộ nhớ | profiler, `process.memoryUsage()` |
| Database | thời gian truy vấn, kết nối | `EXPLAIN ANALYZE`, `pg_stat_statements` |
| Filesystem | I/O wait, dung lượng | `iostat`, `df -h` |
| API ngoài | thời gian phản hồi, timeout | log request kèm thời lượng |

## Database — PostgreSQL

Toàn bộ truy vấn dưới đây là **chỉ đọc**. `oracle` không chạy `UPDATE`/`ALTER`/`DELETE`
trên database thật — đó là thao tác khó đảo ngược, phải qua main và principal.

```sql
-- truy vấn chậm (cần extension pg_stat_statements)
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC LIMIT 20;

-- truy vấn đang chạy ngay lúc này
SELECT pid, now() - query_start AS duration, query, state
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY duration DESC;

-- kích thước bảng
SELECT relname, pg_size_pretty(pg_total_relation_size(relid))
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC LIMIT 20;

-- thiếu index: quét tuần tự nhiều trên bảng lớn
SELECT relname, seq_scan, seq_tup_read, idx_scan
FROM pg_stat_user_tables
WHERE seq_scan > 100 AND seq_tup_read > 10000
ORDER BY seq_tup_read DESC;

-- trạng thái pool kết nối
SELECT count(*), state FROM pg_stat_activity GROUP BY state;
```

Phân tích một truy vấn cụ thể:

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) <truy vấn>;
```

**Tìm:** quét tuần tự trên bảng lớn · nested loop với số dòng cao · sort không có index ·
số lần chạm buffer bất thường.

## Ứng dụng — nút thắt thường gặp

| Vấn đề | Triệu chứng | Hướng sửa |
|---|---|---|
| N+1 truy vấn | rất nhiều truy vấn nhỏ mỗi request | nạp sớm, gộp truy vấn |
| Rò bộ nhớ | bộ nhớ tăng dần theo thời gian | profile heap, kiểm event listener |
| I/O chặn | thời gian phản hồi cao, CPU thấp | bất đồng bộ, pool kết nối |
| Nghẽn CPU | CPU cao, tỷ lệ thuận với tải | tối ưu thuật toán, cache |
| Cạn kết nối | timeout lúc có lúc không | chỉnh kích thước pool, dùng lại kết nối |
| Payload lớn | truyền chậm, tốn bộ nhớ | phân trang, nén, streaming |

Cặp **"thời gian phản hồi cao + CPU thấp"** là dấu hiệu rõ nhất: hệ đang **chờ**, không
phải đang **tính**. Đừng đi tối ưu thuật toán khi CPU đang rảnh.

## Thứ tự tối ưu

1. **Thắng nhanh** — thêm index còn thiếu, sửa N+1, bật cache.
2. **Cấu hình** — kích thước pool, timeout, buffer, số worker.
3. **Code** — tối ưu thuật toán, đổi cấu trúc dữ liệu.
4. **Kiến trúc** — tầng cache, read replica, xử lý bất đồng bộ, CDN.

Đi từ trên xuống. Bước 4 đắt và khó đảo ngược; bước 1 thường giải quyết phần lớn vấn đề.

**Mỗi lần một thay đổi, đo lại sau mỗi lần.** Đổi ba thứ cùng lúc rồi thấy nhanh hơn thì
không biết thứ nào có tác dụng — và hai thứ kia có thể đang làm chậm đi.

## Đưa vào báo cáo

- **Số đo trước và sau**, có con số. Không có số thì không phải chẩn đoán hiệu năng.
- **Nút thắt nằm ở tầng nào**, kèm bằng chứng.
- **Nguyên nhân gốc** — vì sao tầng đó chậm.
- **Đề xuất sửa** kèm tác động mong đợi.
- **Cách kiểm chứng** rằng bản sửa có hiệu quả.
