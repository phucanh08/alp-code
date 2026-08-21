# P2 — `alp` CLI + `alp init`

> ~1 ngày · phụ thuộc P1

## Mục tiêu

Đứng trong bất kỳ repo nào, gõ `alp init` một lần. Từ đó `claude` (hoặc `codex`) trong repo
đó = Phở. Không `cd`, không flag.

## Việc

### 2.1 `scripts/alp.cjs` — dispatcher

| Lệnh | Việc |
|---|---|
| `alp init` | đăng ký project hiện tại + sinh config Claude/Codex + trust |
| `alp init --uninstall` | gỡ config cục bộ, huỷ đăng ký |
| `alp doctor` | → P4 |
| `alp update` | `git -C $ALP_HOME pull --ff-only` + `bootstrap.cjs` |
| `alp help` | gom 9 scripts về một chỗ |
| `alp` (không tham số) | phiên Phở **read-only** ở cwd bất kỳ |

`alp` không tham số = `claude --settings <identity/main/.claude/settings.json> --add-dir <cwd>`
với cwd **không** có quyền Edit. Đã đo: `--settings` nạp hook, giữ cwd, `ALP_ROLE` qua env OK.

Symlink vào PATH ở `bootstrap.cjs` (`~/.local/bin/alp`, fallback báo path nếu không ghi được).
`.sh`/`.ps1` chỉ là wrapper — bản thật là `.cjs`, theo luật repo.

### 2.2 `scripts/lib/project-config.cjs` (module mới)

Sinh 2 file trong project, **cùng nguồn `loadout.yaml`**:

**`<project>/.claude/settings.local.json`** — slot **cá nhân**, Claude Code tự gitignore
⇒ không bẩn repo người khác. Nội dung: hooks + permissions của main +
`"env": { "ALP_ROLE": "main" }`.

**`<project>/.codex/config.toml`** — layer project (cao hơn user config, theo
`codex-rs/config/src/loader`). Nội dung: profile main + hooks.

### 2.3 Trust CẢ HAI runtime — **BẪY 3**

Test đã chứng minh: pane mới ở cwd chưa trust → Claude hỏi *"Is this a project you trust?"*
và **hook KHÔNG chạy** cho tới khi trả lời. Không trust = delegation **chết câm**.

- Claude: `~/.claude.json` (tái dùng `trust-role.cjs`)
- Codex: `[projects."<path>"] trust_level = "trusted"` trong `~/.codex/config.toml`

### 2.4 ACL cho cwd

Claude Code **mặc nhiên cho ghi cwd**. Project chưa đăng ký ⇒ phải **deny tường minh**:

```
"deny": ["Edit(//<cwd>/**)", "Write(//<cwd>/**)"]
```

`alp init` mới thêm cwd vào `workspaces.write` của main rồi recompile.
Không có bước này thì bất biến CHARTER vỡ **im lặng** — không lỗi, không cảnh báo.

### 2.5 Tái dùng, không viết lại

`install-project.cjs` đã làm project card L1 + L0 + loadout workspaces. `alp init` **gọi nó**,
không copy logic. Idempotent: chạy 2 lần liên tiếp cho cùng kết quả.

### 2.6 Test

- `test-project-config.cjs` (mới): idempotent · `--uninstall` sạch · cwd chưa đăng ký thì
  `.claude/settings.local.json` có deny Edit
- `test-isolation.cjs` 20 ca vẫn xanh
- Manual: `cd /tmp/repo-thử && alp init && claude` → boot ra Phở, không dialog trust

## Định nghĩa hoàn thành

- [ ] `alp init` trong repo lạ → `claude` ra Phở, `codex` ra Phở
- [ ] Không dialog trust ở cả hai runtime
- [ ] `alp` ở thư mục chưa init → phiên read-only, thử Edit bị chặn
- [ ] `alp init --uninstall` xoá sạch, `git status` repo đó không đổi
- [ ] chạy `alp init` 2 lần → kết quả giống hệt
