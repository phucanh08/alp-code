---
name: security-scan
description: Quét bảo mật bằng Grep + shell — secret lộ, phụ thuộc có CVE, mẫu lỗ hổng phổ biến, .env bị track. Kích hoạt khi được giao concern security, khi nghi có credential trong code, hoặc trước khi chốt một thay đổi chạm xác thực hay dữ liệu.
---

# security-scan — quét lỗ hổng cơ học

Dùng cho concern `security`. Đây là bước **quét**, không phải bước
kết luận: nó tìm chỗ đáng ngờ nhanh và đầy đủ, còn xác định có thật là lỗ hổng hay không
vẫn là việc đọc code của bạn.

Không cần cài gì thêm — chỉ `Grep`, `Glob` và `Bash`.

## Thứ tự chạy

Chạy đúng thứ tự này. Secret trước vì nó là loại phát hiện **khẩn cấp nhất** — một key lộ
cần xoay ngay, không đợi hết báo cáo.

### 1. Nhận diện loại project

`package.json` → Node · `requirements.txt`/`pyproject.toml` → Python · `go.mod` → Go ·
`Cargo.toml` → Rust. Không nhận ra thì bỏ bước audit phụ thuộc, nói rõ trong báo cáo.

### 2. Quét secret — luôn chạy

Mẫu regex: `references/secret-patterns.md`.

Bỏ qua: `.env.example`, fixture test, tài liệu, `node_modules/`, `dist/`, `vendor/`.

Mỗi khớp phải tự hỏi: đây là secret thật hay placeholder (`YOUR_API_KEY`, `xxx`, `changeme`)?
Placeholder mà báo CHẶN là cách nhanh nhất để lần sau không ai đọc báo cáo của bạn nữa.

### 3. Audit phụ thuộc

```bash
npm audit --json 2>/dev/null || echo 'npm audit không chạy được'
pip-audit --format json 2>/dev/null || echo 'pip-audit không có'
```

Không chạy được thì ghi "chưa audit được vì …" — **không** suy ra là sạch.

### 4. Mẫu lỗ hổng trong code

Mẫu: `references/vulnerability-patterns.md`. Grep xong thì **đọc 5–10 dòng quanh chỗ khớp**
rồi mới kết luận. Grep một mình chỉ ra chỗ đáng nhìn, không ra lỗ hổng.

Nhóm chính: SQL injection (nối chuỗi vào query), XSS (`innerHTML`,
`dangerouslySetInnerHTML` không sanitize), command injection (`exec`/`spawn` với input
chưa lọc), path traversal, randomness không an toàn (`Math.random` cho mục đích bảo mật),
`eval()`/`Function()` với input động.

### 5. Kiểm tra .env bị track

```bash
git ls-files --error-unmatch .env .env.local .env.production 2>/dev/null
grep -n '\.env' .gitignore 2>/dev/null
```

## Luật cứng khi xử lý secret

- **Không bao giờ in giá trị secret thật ra báo cáo.** Che còn 4 ký tự đầu + 2 ký tự cuối.
- **Không chạy, không dùng, không thử** credential tìm được. Kể cả để "kiểm chứng xem có
  thật không" — dùng thử một key thật là hành động khó đảo ngược (HOUSE-RULES §1.2).
- Tìm thấy credential thật → khuyến nghị **xoay ngay**, và nói rõ nó đã nằm trong lịch sử
  git thì xoá file không đủ.
- Không tự sửa code, kể cả khi loadout có cấp `Edit`. Quét là việc đọc.

## Mẫu báo cáo

Dùng đúng ba mức của `code-review` để bên giao việc không phải quy đổi thang.

```
## Quét bảo mật: <scope>

Đã chạy: <lệnh nào chạy được, lệnh nào không>
File đã quét: <số>

Tổng: CHẶN n · NÊN SỬA n · GHI NHẬN n

### CHẶN
- [SECRET] `src/config.js:42` — AWS key, khớp `AKIA[0-9A-Z]{16}`, giá trị `AKIA…4F`
  Sửa: xoay key ngay, chuyển sang biến môi trường. Key đã vào lịch sử git.
- [SQLi] `src/db/user.ts:88` — nối trực tiếp `req.query.id` vào câu SQL
  Bằng chứng: <đoạn code>

### NÊN SỬA
- …

### GHI NHẬN
- …

### Chưa kiểm chứng được
<phần grep khớp nhưng chưa đọc đủ ngữ cảnh để kết luận, và vì sao>
```

## Phạm vi

**Làm:** phát hiện secret, audit phụ thuộc, mẫu lỗ hổng phổ biến, `.env` bị track.

**Không làm:** pentest, phân tích lúc chạy, bảo mật hạ tầng, audit tuân thủ. Việc đó vượt
quá thứ đọc code tĩnh trả lời được — gặp thì báo lại, đừng giả vờ kết luận.
