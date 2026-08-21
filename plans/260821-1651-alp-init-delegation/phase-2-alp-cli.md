# P2 — `alp` CLI + `alp init`

> ~1 ngày · phụ thuộc P1
>
> **Trạng thái: XONG (2026-08-21).** Phần "Đã làm gì" cuối file có ba chỗ plan thiếu và
> một bug chỉ lộ ở lần chạy thứ hai — đọc trước khi làm P3/P4.

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

- [x] `alp init` trong repo lạ → sinh `.claude/settings.local.json` + `.codex/config.toml`,
      cả hai mang `ALP_ROLE=main` và hook boot
- [x] Trust ghi cho cả hai runtime trong cùng một lượt (`~/.claude.json` · `~/.codex/config.toml`)
- [x] `alp` ở thư mục chưa init → phiên read-only; Edit **và** Bash ghi đều bị chặn
- [x] `alp init --uninstall` xoá sạch, `git status` repo đó không đổi
- [x] chạy `alp init` 2 lần → kết quả byte-identical

Nghiệm thu: `node scripts/test-project-config.cjs` — 35 ca, 7 nhóm. `test-isolation` 23/23
vẫn xanh.

**Chưa kiểm được bằng máy:** chuỗi thật `alp init && claude` → boot ra Phở không dialog.
Test khoá argv + env + nội dung file sinh ra; phần Claude Code đọc `--settings` và
`settings.local.json` thì P1 đã đo và không đo lại được trong test tự động.

---

## Đã làm gì — ba chỗ plan thiếu, một bug chỉ lộ ở lần chạy thứ hai

### Bug: trust Codex hỏng ở lần `alp init` THỨ HAI

`trust_level` được thêm bằng regex `/^\s*trust_level\s*=.*$/m`. `\s` nuốt cả `\n`, nên lần
thứ hai nó ăn mất dòng trống sau header và dán thành:

```toml
[projects."/path"]trust_level = "trusted"
```

TOML hỏng ⇒ Codex bỏ qua trust ⇒ hook cấp project chết câm. Lần chạy đầu **hoàn toàn bình
thường**, nên chỉ có ca test idempotent mới bắt được. Sửa: `[ \t]*`, không bao giờ `\s*`
khi neo dòng trong file cấu hình.

### Thiếu 1: `deny` không chặn được Bash — phiên "read-only" mới đúng một nửa

Plan viết `"deny": ["Edit(//<cwd>/**)", "Write(//<cwd>/**)"]`. Hai chỗ sai:

- `Write(path)` **không được Claude Code hỗ trợ** — bị bỏ qua kèm warning lúc boot; chính
  `doctor.cjs` đã có finding `ACL-SYNTAX` cho đúng lỗi này. Chỉ sinh `Edit(...)`, nó phủ
  Write/NotebookEdit.
- `deny` chỉ hiểu tool file. `echo x > note.txt` qua Bash thì không luật path nào chặn — mà
  Bash là lỗ hổng duy nhất đủ để phá cách ly (CHARTER §6).

Thêm `ALP_READONLY_DIRS` (env, phân tách bằng `path.delimiter`) và `checkReadonlyDirs()`
trong `acl-guard.cjs`, chạy **trước** khi giải vai — `alp` đứng ngoài alp-code nên ctx có
thể null mà luật vẫn phải có hiệu lực. Bắt hai dạng mục tiêu: token trông giống path, và
đích của `>`/`>>` (dạng tên trần mà `pathTokens` bỏ qua). `cd`-rồi-ghi-tên-trần vẫn lọt —
guardrail, không phải sandbox.

### Thiếu 2: "tái dùng, không viết lại" phải áp cho cả bộ sinh settings

Plan chỉ dặn tái dùng `install-project.cjs`. Nhưng `settings.local.json` cần **đúng
deny-list** của `identity/<role>/settings.json` — mà deny-list là chỗ CHARTER §4 cấm nhân
bản (thiếu một dòng = một vai bị đọc trộm, không ai biết). Tách
`scripts/lib/claude-settings.cjs`; `compile-acl.cjs` và `alp init` cùng gọi nó. Đầu ra của
compile-acl không đổi một byte (`--check` xanh ngay sau khi tách).

Tương tự: `lib/trust.cjs` (trust-role.cjs + alp init) và `L.writeWorkspaces()`
(install-project thêm, `--uninstall` bớt — hai chiều của một phép sửa).

### Thiếu 3: "không bẩn repo người khác" cần nhiều hơn `settings.local.json`

Claude Code tự giấu `settings.local.json`, nhưng `.codex/config.toml` thì không, và
`.gitignore` là file **được tracked** — sửa vào đó chính là làm bẩn repo. Dùng khối exclude
per-clone (`info/exclude` trong thư mục git), gắn marker để `--uninstall` gỡ đúng khối mình
thêm. Nếu project **đang track** một trong hai file thì exclude vô hiệu — in `WARN`, không
tự xử lý hộ.

Và: file `settings.local.json` sẵn có của người dùng được đổi tên thành `.alp-backup`,
`--uninstall` trả lại nguyên văn. Không có bước này thì "gỡ xong git status không đổi" là
lời hứa suông với bất kỳ ai đã có settings riêng.

### Ăn theo

- Thứ tự trong `alp init` là bắt buộc: **đăng ký trước, sinh config sau**. Config cục bộ đọc
  `workspaces` để quyết định có deny cwd hay không — đảo lại thì project vừa init vẫn bị
  khoá chỉ-đọc, mà không có lỗi nào nổ.
- `buildProfile(..., { sandboxMode })`: profile trong `$CODEX_HOME` giữ `read-only` (launcher
  nâng theo từng lần chạy), còn `<project>/.codex/config.toml` **không có launcher nào chen
  vào giữa** nên phải mang đúng mức quyền — `workspace-write` khi project đã đăng ký.
- `bootstrap.cjs` symlink `~/.local/bin/alp`. Không sửa `.bashrc`/`.zshrc` hộ ai; ghi không
  được thì in path ra. Trùng tên file thật của người khác thì bỏ qua, không đè.
- `alp init --uninstall` **không** xoá `memory/projects/<slug>/` và **không** gỡ trust. Xoá
  trí nhớ vì một lệnh gỡ config là mất cân xứng; gỡ trust thì đụng vào khối
  `[projects."..."]` mà người dùng có thể đã tự thêm khoá khác vào.

### File đã đụng

`scripts/alp.cjs` · `alp.sh` · `alp.ps1` (mới) · `scripts/lib/project-config.cjs` ·
`lib/claude-settings.cjs` · `lib/trust.cjs` (mới) · `scripts/lib/loadout.cjs` ·
`lib/codex-profile.cjs` · `scripts/compile-acl.cjs` · `scripts/trust-role.cjs` ·
`scripts/install-project.cjs` · `scripts/bootstrap.cjs` · `hooks/acl-guard.cjs` ·
`scripts/test-project-config.cjs` (mới) · `README.md`

### Còn nợ

- **Hook Codex trên Windows.** `command` vẫn là cú pháp POSIX. Trường `commandWindows` CÓ
  trong `HookHandlerConfig::Command` (đọc được trong binary codex-cli 0.149.0), nhưng
  `codex doctor` **không** validate khoá lạ trong khối hook — thử với một khoá bịa đặt vẫn
  báo "config loaded". Tức là đoán sai thì hỏng IM LẶNG trên macOS luôn, không chỉ Windows.
  Chưa có máy Windows để đo ⇒ **không đoán**, để nguyên và ghi nợ. `alp.ps1` đã có (parity
  tối thiểu như plan chốt).
- `alp doctor` mới chỉ là passthrough sang `doctor.cjs` — finding riêng cho project đã init
  (config lệch loadout, trust rơi mất) là việc của P4.
- Gỡ cài alp-code toàn phần vẫn chưa xoá `$CODEX_HOME/<role>.config.toml` (nợ từ P1).
