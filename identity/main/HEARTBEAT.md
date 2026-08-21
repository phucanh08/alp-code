# HEARTBEAT — Checklist định kỳ

> Vai main đọc file này khi chạy theo lịch (cron / `/loop` / `/schedule`), hoặc khi principal
> hỏi "có gì mới không?".
> Nguyên tắc: **im lặng là mặc định.** Chỉ lên tiếng khi thật sự có gì đáng nói.

## Mỗi lần tick

1. **Chạy `scripts/doctor.sh`** — có `DRIFT`/`STALE`/`ORPHAN`/`ACL-*`/`REGISTRY-DRIFT` không?
2. **Quét L0** — `memory/projects/INDEX.md`: mục nào đang `BLOCKED` hoặc `WAITING`?
3. **Kiểm tra deadline** — có mốc nào tới trong 48h không?
4. **Kiểm tra việc tồn** — task nào mình nhận mà chưa đóng?
5. **Kiểm tra agent** — có agent nào chạy quá lâu bất thường không?

Chỉ đọc L0. Mở L1 khi có tín hiệu cần đào sâu, không mở dự phòng.

## Ngưỡng báo cáo

**Lên tiếng khi:**
- Script báo `STALE` — project khai ACTIVE mà hai tuần không ai đụng.
- Script báo `DRIFT` hoặc `ORPHAN` mà mình không tự sửa được.
- Một mục chuyển sang `BLOCKED` và chưa được báo.
- Deadline trong 48h mà việc chưa xong.
- Một agent chạy nền đã kết thúc, có kết quả cần mình tổng hợp.
- Một quyết định chờ principal đã treo quá 3 ngày.
- Có gì đó hỏng (build đỏ, test fail, service down).

**Im lặng khi:**
- Mọi thứ tiến triển bình thường.
- Chỉ có thay đổi vụn vặt, không đổi bức tranh tổng thể.
- Nội dung báo cáo trùng với lần tick trước.

Lặp lại một thông tin cũ để tỏ ra hữu ích là **phản tác dụng** — nó dạy principal bỏ qua
báo cáo của mình.

## Định dạng báo cáo heartbeat

Tối đa 5 dòng:

```
<emoji> <ngày> — <một câu tình hình chung>
⚠️  <việc cần chú ý> → <hành động đề xuất>
⏳ <deadline gần> → <còn bao lâu>
```

## Việc dọn dẹp định kỳ

| Nhịp | Việc |
|---|---|
| Hàng tuần | `scripts/sync-project-index.sh --write` — đồng bộ L0 |
| Hàng tuần | Rà `memory/INDEX.md`: xoá fact sai, gộp file trùng |
| Hàng tuần | Đối chiếu L1 với thực tế repo (việc kế còn đúng không?) |
| Hàng tháng | Rà `identity/_shared/PRINCIPAL.md`: sở thích nào đã lỗi thời? |
| Hàng tháng | Rà `decisions/`: quyết định nào đã bị thay thế? |
| Hàng tháng | L1 nào phình quá 60 dòng → đẩy bớt xuống L2 |

## Ranh giới khi chạy tự động

Khi tick tự động, **chỉ đọc và báo cáo**. Không sửa code, không commit, không deploy,
không gửi gì ra ngoài. Muốn hành động → đề xuất, chờ principal.
