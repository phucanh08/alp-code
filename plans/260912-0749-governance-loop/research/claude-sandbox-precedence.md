# Đo: precedence `allowWrite` / `denyWrite` của Claude Code sandbox

**Đo ngày:** 2026-09-12 · **Binary:** `claude` 2.1.269 (Claude Code) · **Platform:** darwin 25.6.0 (Seatbelt) · **Model chạy lệnh:** haiku (`-p`, `--allowedTools Bash`, `autoAllowBashIfSandboxed`).

Mục đích: chọn phương án cưỡng chế `writeScope` (P2) cho Claude. Câu hỏi: khi `allowWrite` là
con của `denyWrite`, cái nào thắng?

## Bố trí

```text
ws/            ← cwd của phiên (mặc định ghi được)
  scope/       ← scope muốn cho ghi
  other/       ← ngoài scope
```

## Lần 1 — phương án (a) của plan: `allowWrite: [ws/scope]` + `denyWrite: [ws]`

| Lệnh | Kết quả |
|---|---|
| `touch scope/a.txt` | `Operation not permitted` |
| `touch other/b.txt` | `Operation not permitted` |

**`denyWrite` thắng `allowWrite` cho write**, kể cả khi allow cụ thể hơn. Khớp tài liệu
(`code.claude.com/docs/en/sandbox-environments`: "denyWrite rules taking precedence over
allowWrite"; ưu tiên "đường dẫn cụ thể hơn" chỉ nói cho **read**). Phương án (a) **không dùng được**.

## Lần 2 — deny từng sibling: `denyWrite: [ws/other]`, không đụng `ws`

| Lệnh | Kết quả |
|---|---|
| `touch scope/a.txt` | tạo được |
| `touch other/b.txt` | `Operation not permitted` |
| `touch new.txt` (file mới ngay dưới `ws/`) | tạo được |

Deny theo sibling **có cưỡng chế** cho những gì tồn tại lúc phóng; **không** ngăn tạo entry
mới ở các tầng trên scope (`ws/new.txt`). Tài liệu cũng ghi: trên Linux/WSL2 sandbox "scan
existing files at startup", đường dẫn tạo trong phiên không được bảo vệ tự động.

## Kết luận cho P2

- Claude darwin/linux: `sandbox.filesystem.denyWrite` = mọi sibling của từng đoạn đường từ
  workspace xuống mỗi scope entry (không `allowWrite`, không deny workspace), **cộng** ACL
  `Edit(//<sibling>/**)` deny cho tool Edit/Write. Mức ghi vào bảng: **`partial`** — từ chối
  ghi vào những gì đã có ngoài scope; không từ chối *tạo mới* bên cạnh.
- Claude win32: không sandbox — chỉ ACL `Edit` deny, Bash không bị chặn: `declared-only`.
- Codex: `writable_roots = [...scope, memory/private/<role>]` — `enforced` (đã đo 2026-09-12 ở P5).
