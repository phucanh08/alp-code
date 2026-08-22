# Cấu hình repomix

## File cấu hình

Đặt `repomix.config.json` ở gốc project:

```json
{
  "output": {
    "filePath": "repomix-output.xml",
    "style": "xml",
    "removeComments": false,
    "showLineNumbers": true,
    "copyToClipboard": false
  },
  "include": ["**/*"],
  "ignore": {
    "useGitignore": true,
    "useDefaultPatterns": true,
    "customPatterns": ["**/*.log", "**/tmp/**"]
  },
  "security": {
    "enableSecurityCheck": true
  }
}
```

Tạo file config trong repo người khác là **sửa repo đó** — hỏi principal trước. Dùng một
lần thì truyền cờ ở dòng lệnh, đừng để lại file.

### Đầu ra

| Khoá | Nghĩa | Mặc định |
|---|---|---|
| `filePath` | file kết quả | `repomix-output.xml` |
| `style` | `xml` · `markdown` · `json` · `plain` | `xml` |
| `removeComments` | bỏ comment | `false` |
| `showLineNumbers` | kèm số dòng | `true` |
| `copyToClipboard` | tự copy | `false` |

Giữ `showLineNumbers: true` khi mục đích là để trích dẫn — không có số dòng thì không dẫn
được `path:line`, mà đó là dạng bằng chứng repo này yêu cầu.

### Lọc file

| Khoá | Nghĩa |
|---|---|
| `include` | glob các file lấy vào (mặc định `["**/*"]`) |
| `useGitignore` | tôn trọng `.gitignore` (mặc định `true`) |
| `useDefaultPatterns` | dùng bộ mẫu bỏ qua mặc định (mặc định `true`) |
| `customPatterns` | mẫu bỏ qua thêm, cú pháp như `.gitignore` |

**Không tắt `useGitignore`.** Nó là lớp bảo vệ đầu tiên chống việc gói nhầm `.env`, secret,
và dữ liệu cục bộ.

### Bảo mật

`enableSecurityCheck` (mặc định `true`) — quét bằng Secretlint: API key, mật khẩu,
credential, private key, secret AWS, chuỗi kết nối DB.

**Không tắt.** Xem phần cuối `SKILL.md`.

## Glob

| Ký hiệu | Khớp |
|---|---|
| `*` | mọi ký tự trừ `/` |
| `**` | mọi ký tự kể cả `/` |
| `?` | một ký tự |
| `[abc]` | một ký tự trong tập |
| `{js,ts}` | một trong các phần mở rộng |

### Thứ tự ưu tiên

Cao xuống thấp:

1. Cờ `-i` ở dòng lệnh
2. File `.repomixignore`
3. `customPatterns` trong config
4. `.gitignore` (nếu bật)
5. Bộ mẫu mặc định (nếu bật)

Cờ dòng lệnh thắng tất cả — tiện, nhưng cũng nghĩa là một cờ `-i` sai chỗ vô hiệu hoá cả
bộ lọc bạn đã cấu hình kỹ.

### Mẫu theo loại project

```json
// TypeScript
{"include": ["**/*.ts", "**/*.tsx"], "ignore": {"customPatterns": ["**/*.test.ts", "dist/"]}}

// React
{"include": ["src/**/*.{js,jsx,ts,tsx}", "*.md"], "ignore": {"customPatterns": ["build/"]}}

// Monorepo
{"include": ["packages/*/src/**"], "ignore": {"customPatterns": ["packages/*/dist/"]}}
```

## Định dạng ra

| Định dạng | Dùng khi |
|---|---|
| `xml` (mặc định) | đưa cho LLM đọc — có tag, phân cấp, metadata |
| `markdown` | người đọc, review, chia sẻ |
| `json` | xử lý bằng script |
| `plain` | nối đơn giản, ít overhead nhất |

Với alp-code, mục đích gần như luôn là đưa cho LLM → giữ `xml`.

## Cờ nâng cao

```bash
repomix --verbose                 # xem nó đang xử lý gì
repomix -c /đường/dẫn/config.json # config riêng
repomix --init                    # tạo repomix.config.json
repomix --no-line-numbers         # output nhỏ hơn, nhưng mất khả năng dẫn path:line
```

## Giảm kích thước

Đây là phần quan trọng nhất khi dùng trong một phiên agent — output quá lớn là hỏng cả phiên.

```bash
repomix --token-count-tree                        # LUÔN chạy trước
repomix -i "node_modules/**,dist/**,*.min.js"     # loại thứ vô ích
repomix --include "src/**/*.ts"                   # chỉ lấy phần cần
repomix --remove-comments --no-line-numbers       # ép nhỏ tối đa
```

Thứ tự đúng: chạy cây token → xem token nằm ở đâu → chốt `--include` → gói. Gói trước rồi
mới đo là làm ngược.

Xử lý song song nên repo lớn vẫn nhanh (facebook/react: 123s → 4s). **Nhanh không có nghĩa
là nên gói cả repo** — giới hạn thật là ngân sách context, không phải thời gian chạy.
