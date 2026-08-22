# Mẫu sử dụng

## Bốn việc repomix làm tốt

### 1. Đánh giá thư viện bên thứ ba

Việc đáng dùng repomix nhất: hiểu nhanh một thư viện lạ trước khi quyết định có dùng không.

```bash
npx repomix --remote https://github.com/owner/repo --token-count-tree
npx repomix --remote https://github.com/owner/repo \
  --include "README.md,docs/**,src/index.*" --style markdown
```

Đọc `README`, `docs/`, và entry point là đủ để đánh giá. Không cần cả `src/`.

### 2. Hiểu một module cụ thể

```bash
repomix --include "src/auth/**" --remove-comments -o auth.md --style markdown
```

Khoanh đúng module, không gói cả repo.

### 3. Chuẩn bị audit bảo mật

```bash
repomix --include "src/**/*.{ts,js}" -i "**/*.test.*" --style xml
```

Giữ quét secret **bật**. Xem lại output trước khi đưa đi đâu.

### 4. Rút bối cảnh cho tài liệu

```bash
repomix --include "src/api/**,docs/**" --style markdown -o api-context.md
```

## Khi KHÔNG dùng repomix

| Việc | Dùng gì thay |
|---|---|
| tìm một symbol, một hàm | `rg` / `Grep` — giao `search` |
| biết đổi chỗ này thì vỡ đâu | `gkg` phân tích ảnh hưởng — giao `search` |
| đọc tài liệu một thư viện | `docs-seeker` — giao `librarian` |
| trả lời một câu hỏi cụ thể về code | `search` trả `path:line` |

repomix đổ hàng chục nghìn token vào context. Dùng nó để trả lời một câu hỏi nhỏ là phá
đúng nguyên tắc "boot set ≤ 7 nguồn" của CHARTER §2.6.

## Xử lý sự cố

### Output quá lớn

```bash
repomix --token-count-tree                                    # xem token ở đâu
repomix -i "node_modules/**,dist/**,coverage/**" \
        --include "src/core/**" --remove-comments --no-line-numbers
```

Cắt `--include` cho tới khi vừa ngân sách. Đừng gói rồi mới lo cắt sau.

### Thiếu file mong đợi

```bash
cat .gitignore .repomixignore                    # xem mẫu nào đang chặn
repomix --no-gitignore --no-default-patterns --verbose
```

Lệnh thứ hai **chỉ để chẩn đoán**, không phải để gói thật — tắt `.gitignore` là mở đường
cho `.env` và dữ liệu cục bộ lọt vào.

### Cảnh báo dữ liệu nhạy cảm

Đúng thứ tự: xem lại file → thêm vào `.repomixignore` → bỏ dữ liệu nhạy cảm khỏi code →
chuyển sang biến môi trường.

```bash
repomix --no-security-check     # CHỈ khi đã xác nhận là báo nhầm, và principal đã biết
```

Tắt quét secret rồi đổ file vào context là cách lộ credential mà không ai nhìn thấy.

### Repo từ xa

```bash
npx repomix --remote https://github.com/owner/repo
npx repomix --remote https://github.com/owner/repo/commit/abc123   # đúng commit
```

Repo private: clone về trước rồi chạy cục bộ — và clone là tải mã nguồn lạ, báo principal.

Ghi lại **commit hoặc tag đã gói**. Không có nó thì kết quả không tái lập được, và không
đối chiếu được khi thư viện ra bản mới.

## Quy trình

**Trước:** khoanh phạm vi → xác định file cần → chạy `--token-count-tree` → nghĩ tới rủi ro
bảo mật.

**Trong:** bắt đầu hẹp rồi mở dần, không làm ngược → chọn định dạng đúng mục đích → giữ
quét secret bật.

**Sau:** xác nhận không có gì nhạy cảm → kiểm đã đủ chưa → **dọn file `repomix-output.*`**.

Bước dọn hay bị quên, và file gói sót lại rất dễ lọt vào commit sau đó.
