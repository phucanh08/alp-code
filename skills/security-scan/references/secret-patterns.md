# Mẫu phát hiện secret

Mẫu regex dùng với `Grep`. Loại trừ file test và file ví dụ **trước khi** quét, không lọc sau.

## Độ tin cậy cao — có cấu trúc, ít báo nhầm

Khớp một trong những mẫu này gần như chắc chắn là secret thật. Xử lý ngay, không đợi quét xong.

| Nguồn | Mẫu |
|---|---|
| AWS | `AKIA[0-9A-Z]{16}` |
| GitHub | `gh[pousr]_[A-Za-z0-9_]{36,255}` · `github_pat_[A-Za-z0-9_]{22,}` |
| Stripe | `sk_live_[0-9a-zA-Z]{24,}` · `rk_live_[0-9a-zA-Z]{24,}` |
| Slack | `xox[baprs]-[0-9a-zA-Z-]{10,}` |
| Google Cloud | `AIza[0-9A-Za-z_-]{35}` |
| Anthropic | `sk-ant-[A-Za-z0-9_-]{40,}` |
| Private key | `-----BEGIN (RSA \|EC \|DSA \|OPENSSH )?PRIVATE KEY-----` |
| JWT trong code | `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` |

Riêng `sk_live_` của Stripe và `AKIA` của AWS: đây là **khoá production**. Tìm thấy thì
khuyến nghị xoay ngay, và nói rõ nó đã nằm trong lịch sử git nên xoá file không đủ.

## Độ tin cậy vừa — phải đọc ngữ cảnh

Mẫu dưới đây khớp cả secret thật lẫn placeholder. **Đọc 5–10 dòng quanh chỗ khớp** rồi mới
kết luận.

**Khoá API chung**

```
(?i)(api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*['"][A-Za-z0-9/+=]{16,}['"]
```

**Chuỗi kết nối database có credential**

```
(?i)(postgres|mysql|mongodb|redis)://[^:]+:[^@]+@
```

**Mật khẩu trong code**

```
(?i)(password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]
```

**Secret chung**

```
(?i)(secret|token|credential)\s*[:=]\s*['"][A-Za-z0-9/+=]{16,}['"]
```

## Loại trừ

Bỏ qua khớp trong:

| Loại | Cụ thể |
|---|---|
| File | `*.example`, `*.test.*`, `*.spec.*`, `*.md`, `*.txt` |
| Thư mục | `node_modules/`, `dist/`, `vendor/`, `__pycache__/` |
| Nội dung | dòng có `TODO`, `FIXME`, `YOUR_`, `REPLACE_`, `xxx`, `placeholder`, `changeme` |
| Nội dung | khai biến không có giá trị thật: `= process.env.`, `= os.getenv(` |

Dòng cuối quan trọng: `const key = process.env.API_KEY` là code **đúng**, không phải lỗ
hổng. Báo nó là CHẶN thì lần sau không ai đọc báo cáo của bạn nữa.

## Khi báo cáo

**Không bao giờ in giá trị secret thật.** Che còn 4 ký tự đầu + 2 ký tự cuối:

```
`src/config.js:42` — AWS key, khớp `AKIA[0-9A-Z]{16}`, giá trị `AKIA…4F`
```

Và **không chạy, không dùng thử** credential tìm được — kể cả để kiểm xem nó còn hiệu lực
không. Dùng thử một khoá thật là thao tác khó đảo ngược (HOUSE-RULES §1.2).
