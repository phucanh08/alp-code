---
title: Thiết lập project
description: Đăng ký, đồng bộ identity và phân biệt project source với machine-local state.
---

`alp init` đăng ký một project để phiên `main` được làm việc với quyền write. Lệnh có thể chạy trong project hoặc nhận một path.

```bash
alp init
alp init ~/code/my-app
```

## Những gì `alp init` tạo

| Vị trí | Sở hữu | Mục đích |
|---|---|---|
| `<project>/.alp/agents/` | Project | Custom agent và built-in skill overlay có thể commit |
| `<project>/.alp/skills/` | Project | Skill dùng chung trong project có thể commit |
| [`<project>/.alp/settings.json`](../customize-mode-loadouts/) | Project, bạn tự viết | Ghi đè loadout mode cho cả team, commit được |
| [`<project>/.alp/settings.local.json`](../customize-mode-loadouts/) | Bạn, machine-local | Ghi đè loadout mode của riêng bạn |
| `<project>/.claude/settings.local.json` | ALP, machine-local | SessionStart hook cho Claude Code |
| `<project>/.claude/skills/`, `.agents/skills/` | ALP, machine-local | Link tới packaged built-in skills |
| `~/.alp/projects.json` | ALP, machine-local | Registry của project đã init |
| `~/.alp/agents/*.md` | ALP, generated | Identity cache mà SessionStart hook đọc |

Hai file settings không do `alp init` tạo — viết khi cần, và xem [Tùy biến loadout của mode](../customize-mode-loadouts/) cho khuôn file. `settings.local.json` nên nằm trong `.gitignore` của project nếu team dùng tới nó.

Generated config/link được thêm vào `.git/info/exclude` của clone, không sửa `.gitignore`. Hai thư mục `.alp/` ban đầu rỗng nên không làm dirty git; khi bạn thêm agent hoặc skill, đó là source của project và nên được review như code.

:::note[Claude wiring hiện tại]
Project init hiện ghi SessionStart config cho Claude Code. Không suy rộng điều này thành một project config tương đương cho mọi runtime; delegated execution nhận settings riêng từ runtime adapter.
:::

## Principal profile

Ở lần init đầu tiên trên TTY, ALP hỏi tên và cách xưng hô. Xem hoặc đổi sau này:

```bash
alp principal show
alp principal set
```

Không có TTY, init vẫn hoàn tất với identity trung tính và gợi ý chạy `alp principal set`; ALP không đoán tên từ Git config.

## Đồng bộ identity

Sau khi built-in definition trong bản phát triển thay đổi:

```bash
alp identity sync
```

Lệnh sinh lại cache dưới `~/.alp/agents/`. Không sửa trực tiếp các file cache để đổi role.

## Gỡ đăng ký project

```bash
alp deinit
alp deinit ~/code/my-app
```

`deinit` gỡ registration và phần generated config/link do ALP sở hữu, phục hồi backup nếu project đã có settings riêng. Nó cố ý giữ nguyên `.alp/agents/`, `.alp/skills/` và project memory.

## Kiểm chứng

- `alp init` in `READY` cùng path canonical.
- `git status --short` không liệt kê generated runtime config/link.
- Chạy `alp` trong project đã init cho `main` quyền write; cwd khác vẫn read-only.

Tiếp theo: [Giao việc cho specialist](../delegation/).
