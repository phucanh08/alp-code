---
name: repomix
description: Đóng gói cả repo thành một file cho AI đọc (XML, Markdown, JSON), có đếm token và quét secret. Kích hoạt khi cần đưa nguyên một codebase lạ vào context, khi đánh giá thư viện bên thứ ba, hoặc khi cần biết token nằm tập trung ở đâu.
---

# repomix — gói repo thành một file

**Chưa vai nào được cấp skill này** trong `compiled AgentDefinition`. Nó nằm ở `skills/` để principal
cấp khi cần — thường là khi phải đánh giá một thư viện lạ.

## Khi nào đáng dùng

Chỉ khi **thật sự cần cả repo**: đánh giá thư viện bên thứ ba, hiểu một codebase chưa từng
đọc, chuẩn bị audit.

Khi **không** nên dùng: tìm một symbol, đọc một luồng, trả lời một câu hỏi cụ thể về code.
Việc đó giao một lượt truy xuất code — nó trả `path:line`, còn repomix đổ hàng chục nghìn
token vào context.
Dùng nhầm chỗ là phá đúng nguyên tắc "boot set ≤ 7 nguồn" của compiled policy invariants.

## Kiểm tra trước

```bash
repomix --version
```

Chưa cài thì **báo principal, đừng tự cài** (HOUSE-RULES §1.2). Cài: `npm install -g repomix`
hoặc `brew install repomix`.

## Dùng cơ bản

```bash
repomix                                   # gói thư mục hiện tại → repomix-output.xml
repomix --style markdown                  # đổi định dạng: xml | markdown | json | plain
repomix --include "src/**/*.ts" -o out.md # lọc + đặt tên file ra
npx repomix --remote owner/repo           # gói repo từ xa, không cần clone
```

**Chỉ gói repo nằm trong `workspaces.read` của loadout.** Gói một repo ngoài danh sách là
đọc thứ mình không được đọc, kể cả khi filesystem không chặn.

| Nhóm | Cờ |
|---|---|
| chọn file | `--include "<glob>"` · `-i "<glob>"` (bỏ qua thêm) · `--no-gitignore` |
| đầu ra | `--style` · `-o <file>` · `--remove-comments` · `--copy` |
| cấu hình | `-c <file>` · `--init` (tạo `repomix.config.json`) |

Đầy đủ: `repomix --help` hoặc `references/configuration.md`.

## Đếm token — phần đáng giá nhất

```bash
repomix --token-count-tree        # cây token toàn repo
repomix --token-count-tree 1000   # chỉ hiện file/thư mục từ 1000 token trở lên
```

```
└── src/ (70,925 tokens)
    ├── cli/ (12,714 tokens)
    └── core/ (41,600 tokens)
```

Chạy cây token **trước** khi gói. Nó cho biết nên `--include` những gì, và tránh việc gói
xong mới phát hiện vượt giới hạn context.

## Bảo mật — đọc trước khi gói bất cứ thứ gì

repomix dùng Secretlint để bắt API key, mật khẩu, private key, AWS secret.

- **Luôn đọc lại output trước khi đưa đi đâu.** Một file gói có thể chứa credential mà
  `.gitignore` che được nhưng `.repomixignore` thì chưa.
- Không gói `.env`.
- **Không tắt `--no-security-check`** trừ khi principal nói thẳng. Tắt quét secret rồi đổ
  file vào context là cách lộ credential mà không ai nhìn thấy.
- File `repomix-output.*` sinh ra trong thư mục làm việc — dọn sau khi dùng, đừng để nó
  lọt vào commit.

## Quy trình

1. Chạy `--token-count-tree`, xem token nằm ở đâu.
2. Chốt `--include`/`-i` cho vừa ngân sách context.
3. Gói, giữ quét secret bật.
4. **Đọc lại output**, xác nhận không có gì nhạy cảm.
5. Báo số token và cảnh báo nếu có.
6. Dọn file gói khi xong.

## Tham chiếu

| File | Nội dung |
|---|---|
| `references/configuration.md` | file config, mẫu include/exclude, định dạng ra |
| `references/usage-patterns.md` | quy trình phân tích, chuẩn bị audit, đánh giá thư viện |

Nguồn: https://github.com/yamadashy/repomix
