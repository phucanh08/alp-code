---
id: claude-code-acl-behavior
type: reference
layer: L3
visibility: team
owner: chief-of-staff
created: 2026-08-21
updated: 2026-08-21
tags: [claude-code, acl, permissions, hooks, security]
source: spike P1.0 — /tmp/acl-spike2, Claude Code 2.1.238, macOS darwin 25.5.0
---

# Hành vi ACL của Claude Code — đo thật, không đoán

Kết quả spike bắt buộc trước khi xây `compile-acl.sh`. **Ba phát hiện, mỗi cái đều đổi kiến trúc.**

## Phát hiện 1 — absolute path trong permission rule phải viết `//`, không phải `/`

`deny: ["Read(/tmp/x/secret/**)"]` → **không chặn gì cả**, ở *mọi* permission mode.
`deny: ["Read(//tmp/x/secret/**)"]` → **chặn đúng**.

Claude Code coi `/…` là path **tương đối tính từ thư mục chứa `settings.json`**.
Một dấu `/` mở đầu bị nuốt. Absolute path cần **hai** dấu: `//Users/oaidq/…`.

⇒ `compile-acl.sh` phải phát ra `Read(//Users/…)`. Sai một ký tự = ACL im lặng vô hiệu,
không có cảnh báo nào. Đây là chế độ hỏng nguy hiểm nhất: **fail-open, không tiếng động.**

## Phát hiện 2 — workspace chưa trusted thì `allow` và `additionalDirectories` bị bỏ qua

Chạy `claude` ở một thư mục chưa từng mở tương tác:

```
Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace has not been trusted.
Ignoring 1 permissions.additionalDirectories entry from .claude/settings.json: this workspace has not been trusted.
```

`deny` **vẫn áp dụng**; chỉ `allow` và `additionalDirectories` bị bỏ.
Hệ quả thực tế: vai mới sẽ **không đọc được `memory/`** cho tới khi được trust.

Hai cách trust:
1. Chạy `claude` tương tác một lần tại thư mục đó, bấm chấp nhận.
2. Đặt `projects["<abs-path>"].hasTrustDialogAccepted = true` trong `~/.claude.json`.

⚠️ macOS: `/tmp` là symlink tới `/private/tmp`. Claude Code dùng **cả hai** dạng path làm key.
Trust phải đặt cho **cả hai** — hoặc dùng `realpath` nhất quán ở mọi nơi.

⇒ `doctor.sh` phải có tín hiệu `TRUST-MISSING`. ⇒ `new-role.sh` phải tự set trust.

## Phát hiện 3 — `deny` SỐNG SÓT qua `bypassPermissions`, `Bash` thì không

| Ca | Mode | Kết quả |
|---|---|---|
| `Read` file bị `deny` (cú pháp `//`) | default | **DENIED** |
| `Read` file bị `deny` (cú pháp `//`) | `acceptEdits` | **DENIED** |
| `Read` file bị `deny` (cú pháp `//`) | **`bypassPermissions`** | **DENIED** ← quan trọng |
| `Bash: cat <file bị deny>` + `deny: Bash(cat:*secret*)` | default | **ALLOWED** ← rò rỉ |
| `Bash: cat <file bị deny>` | `bypassPermissions` | **ALLOWED** ← rò rỉ |
| `Read` file trong grant (đối chứng) | default | ALLOWED — không chặn nhầm |

Lỗi trả về khi bị chặn: `File is in a directory that is denied by your permission settings.`

**`deny` không bị `bypassPermissions` vô hiệu.** Đây là tin tốt, và ngược với lo ngại ban đầu.

**Nhưng `deny` chỉ hiểu tool file.** Không luật `Bash(...)` nào chặn nổi `cat <path>` một cách
đáng tin — pattern `Bash(cmd:*)` khớp theo **prefix chuỗi lệnh**, không resolve path.
Bash là lỗ hổng duy nhất, và nó đủ để phá toàn bộ cách ly.

## Phát hiện 4 — hook `PreToolUse` fire ở MỌI mode, kể cả bypass

Hook trả `permissionDecision: "deny"` chặn thành công **cả `Bash` lẫn `Read`** khi chạy
`--permission-mode bypassPermissions`. Log của hook xác nhận nó thực sự được gọi:

```
FIRED tool=Bash input={"command":"cat /tmp/acl-spike2/ws/secret/leak.txt",...}
FIRED tool=Read input={"file_path":"/tmp/acl-spike2/ws/secret/leak.txt"}
```

Matcher regex `Bash|Read|Edit|Write|Glob|Grep` hoạt động đúng.

## Phát hiện 5 — path rule chỉ dùng `Read` và `Edit`

Claude Code 2.1.238 cảnh báo và bỏ qua các permission rule dạng
`Glob(path)`, `Grep(path)`, `Write(path)` và `NotebookEdit(path)`.

- `Read(path)` bao phủ mọi file-reading tool, gồm Read/Glob/Grep.
- `Edit(path)` bao phủ mọi file-editing tool, gồm Edit/Write/NotebookEdit.

Đây chỉ là cú pháp của `permissions.deny`; matcher hook vẫn phải liệt kê đầy đủ từng tool.
`compile-acl.sh` vì vậy chỉ sinh `Read(//...)` và `Edit(//...)` cho path rule.

## Kết luận kiến trúc

| Lớp | Phủ | Vai trò |
|---|---|---|
| `permissions.deny` (cú pháp `//`) | `Read` `Edit` `Write` `Glob` `Grep` | lớp chính cho tool file — sống sót cả bypass |
| `hooks/acl-guard.cjs` (`PreToolUse`) | **`Bash`** + phủ chồng tool file | **lớp DUY NHẤT** chặn được Bash |
| `additionalDirectories` | mở quyền đọc | **chỉ chạy khi workspace đã trusted** |

Không lớp nào đủ một mình:
- Chỉ settings → `cat` lách được.
- Chỉ hook → hook lỗi là mở toang.
- Chưa trust → `allow`/`additionalDirectories` im lặng biến mất.

**Vì sao `acl-guard.cjs` vẫn phủ cả tool file dù `deny` đã lo:** nó là lưới an toàn cho
đúng ba chế độ hỏng ở trên — settings sinh sai cú pháp, workspace mất trust, ai đó sửa tay
`settings.json`. Chi phí thêm gần bằng không (cùng một hàm `check(path)`), giá trị cao.

**Vì sao vẫn cần cả `deny`:** hook chết là mở toang. `deny` chạy trong lõi harness,
không phụ thuộc process ngoài.

## Giới hạn còn lại — nói thẳng

Không lớp nào chống được agent **cố tình** lách: viết file rồi chạy, `python -c`, `eval`,
`base64`. `acl-guard.cjs` quét indirection theo regex và default-deny khi gặp — chặn nhầm
lẫn, **không** chặn kẻ thù. Cách ly thật cần OS user riêng hoặc container.

**Vì sao quan trọng:** ba dòng cấu hình sai đủ để ACL im lặng vô hiệu mà không ai biết.
**Áp dụng thế nào:** `compile-acl.sh` sinh `//`; `doctor.sh` kiểm trust + cú pháp; test
cách ly phải chạy ở **cả** `default` **và** mode thật đang dùng.

Liên quan: [[agent-memory-architecture]]
