---
id: agent-memory-architecture
type: decision
layer: L3
visibility: team
owner: main
created: 2026-08-21
updated: 2026-08-21
tags: [architecture, acl, identity, memory, multi-agent]
source: plans/260821-0930-multi-agent-identity-memory/
---

# Kiến trúc agent-memory — identity theo vai, memory dùng chung, ACL sinh từ loadout

Chốt ngày 2026-08-21, thay thế cấu trúc cũ `agent-team/pho` (một agent, identity + memory +
projects trộn ở root).

## Quyết định

**Một repo, nhiều vai, một kho trí nhớ.** Mỗi vai chạy một phiên Claude Code riêng với
CWD riêng `identity/<role>/`, nhưng cùng nhìn vào một `memory/`.

Sáu nguyên tắc bất biến ở [`CHARTER.md`](../../../CHARTER.md) §2. Ba cái quan trọng nhất:

1. **Key theo vai trò, không theo tên.** Thư mục là `main`, tên người là
   `name: Phở` trong `loadout.yaml`. Đổi tên = sửa **một dòng**, không path nào đổi,
   không recompile ACL. Đã kiểm chứng.
2. **`loadout.yaml` là nguồn sự thật duy nhất của ACL.** `.claude/settings.json` là sản
   phẩm sinh ra bởi `scripts/compile-acl.sh` — không sửa tay, không commit (gitignore).
3. **Cách ly hai chiều.** Main **không** phải root: không đọc được
   `memory/private/researcher/`. `private` mà cấp trên đọc được thì không còn là `private`.

## Vì sao ba lớp enforce, không phải một

Spike bắt buộc trước khi xây đã đo được ba hành vi quyết định kiến trúc — chi tiết ở
[[claude-code-acl-behavior]]:

| Lớp | Phủ | Điểm yếu |
|---|---|---|
| `permissions.deny` | tool file, sống sót cả `bypassPermissions` | **không chặn được `Bash`**; path phải viết `//`; im lặng vô hiệu nếu sai |
| `hooks/acl-guard.cjs` | **`Bash`** + phủ chồng tool file | hook chết là mở toang → fail-closed |
| `additionalDirectories` | mở quyền đọc | **bị bỏ qua khi workspace chưa trusted** |

Không lớp nào đủ một mình. Đó là lý do `compile-acl.sh` phát cả `deny` lẫn khối `hooks`,
và `doctor.sh` có tín hiệu riêng cho từng chế độ hỏng (`ACL-SYNTAX`, `TRUST-MISSING`,
`ACL-STALE`, `ACL-PATH`).

## Vì sao `compile-acl.sh` mặc định là `--all`

`deny` thắng `allow`, nên **không** viết được luật "cấm `private/**`, trừ `private/<mình>/**`".
Bắt buộc liệt kê từng vai anh em trong deny-list của mọi vai. Thêm một vai mà không
recompile ⇒ settings của **mọi vai cũ** thiếu một dòng deny ⇒ vai mới bị đọc trộm ngay.

Hệ quả: `scripts/new-role.sh` là con đường **duy nhất** để thêm vai. Tạo tay bằng `cp -r`
là vi phạm hiến chương.

## Đánh đổi đã chấp nhận

- **`acl-guard.cjs` là guardrail, không phải sandbox.** Nó chặn nhầm lẫn và vượt quyền tình
  cờ, **không** chặn agent cố tình lách (ghi file rồi chạy, ngôn ngữ script khác). Cách ly
  thật với agent thù địch cần OS user riêng hoặc container — ngoài phạm vi.
  Hệ này giả định agent **hợp tác**, và bảo vệ *tính đúng đắn của dữ liệu* + *sự tập trung
  của context*, không phải bí mật quốc gia.
- **Quét indirection là default-deny.** Lệnh chứa `eval` / `$(...)` / backtick / `-c` bị
  từ chối vì không kiểm được path bên trong. Thà chặn nhầm lệnh hợp lệ còn hơn để lọt;
  agent viết lại lệnh tường minh, chi phí thấp.
- **Boot set ~4.2k token, hơi vượt mục tiêu ~4k.** Tiếng Việt có dấu tốn ~3.5 ký tự/token.
  Hook cảnh báo khi vượt ngưỡng ký tự nhưng **không cắt** — cắt thầm lặng nguy hiểm hơn.
- **Ngoài phạm vi, để sau:** SQLite FTS5, vector search, web panel, auto-extract bằng LLM.

## Vì sao quan trọng

Trước: thêm agent thứ hai nghĩa là copy cả bộ file, hai bản `USER.md` lệch nhau, không có
ranh giới nào giữa nháp và fact.
Sau: `new-role.sh <slug>` trong dưới một giây, một bản `PRINCIPAL.md`, và ranh giới
`shared`/`private` được harness enforce chứ không dựa vào agent tự giác.

## Áp dụng thế nào

Thêm vai → `scripts/new-role.sh`. Đổi quyền → sửa `loadout.yaml` rồi `compile-acl.sh`.
Nghi ngờ có gì lệch → `scripts/doctor.sh`. Sửa `checkPath` → chạy lại
`scripts/test-isolation.sh` (20 ca, gồm cả ca ALLOW).

Liên quan: [[claude-code-acl-behavior]]
