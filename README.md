# agent-memory

Identity + trí nhớ dùng chung cho nhiều agent. Mỗi vai một phiên Claude Code riêng,
cùng một kho trí nhớ, ACL do harness enforce.

Luật nền: [`CHARTER.md`](CHARTER.md). Danh bạ các vai: [`identity/REGISTRY.md`](identity/REGISTRY.md).

## Các vai hiện có

| Vai | Tên | Việc |
|---|---|---|
| `chief-of-staff` | Phở 🍜 | điều phối agents, vận hành project, chốt quyết định |
| `researcher` | Long 🔎 | tra cứu bằng nguồn sơ cấp, để lại tài liệu tái dùng |

## Chạy một vai

```bash
cd identity/chief-of-staff && claude
```

Hook `SessionStart` tự nạp identity. Không cần đọc file thủ công.

> **Trust dialog:** workspace chưa trusted thì Claude Code **bỏ qua** `permissions.allow`
> và `additionalDirectories` ⇒ vai đó mở được phiên nhưng không đọc nổi `memory/`.
> `new-role.sh` tự chạy `trust-role.sh`; `doctor.sh` báo `TRUST-MISSING` nếu thiếu.

## Thêm một vai

```bash
scripts/new-role.sh qa --name QA --emoji 🧪
```

**Đây là con đường duy nhất.** Tạo thư mục bằng tay = mọi vai cũ thiếu deny cho vai mới
= rò rỉ. Xem `CHARTER.md` §4.

## Gắn một project code có sẵn

macOS/Linux:

```bash
scripts/install-project.sh /absolute/path/to/my-app --slug my-app
```

Windows PowerShell:

```powershell
.\scripts\install-project.ps1 C:\Projects\my-app --slug my-app
```

Mặc định mọi vai được đọc workspace, còn `chief-of-staff` được ghi. Tuỳ chỉnh bằng option
lặp lại `--read-role <role>` và `--write-role <role>`. Installer tạo project card, cập nhật
L0, ghi `workspaces.read/write` vào loadout và recompile ACL cho mọi vai. Chạy lại cùng
project là an toàn (idempotent), không ghi đè `PROJECT.md` đã có.

## Cây thư mục

```
agent-memory/
├── CHARTER.md              hiến chương — chỉ principal sửa
├── identity/
│   ├── REGISTRY.md         ai tồn tại
│   ├── _shared/            PRINCIPAL · VOICE · HOUSE-RULES (boot) · DELEGATION · CONVENTIONS
│   ├── _template/          khuôn cho vai mới
│   └── <role>/             IDENTITY · SOUL · PLAYBOOK · RELATIONS · loadout.yaml · journal/
│                           (+ .claude/settings.json — SINH RA, không commit)
├── memory/
│   ├── INDEX.md            mục lục trí nhớ chung
│   ├── shared/             decisions · people · reference
│   ├── projects/           Project Layer 3 tầng
│   └── private/<role>/     nháp riêng, cách ly hai chiều
├── skills/agent-memory/    luật ghi trí nhớ
├── hooks/                  session-start · acl-guard · session-end
├── scripts/                compile-acl · new-role · doctor · trust-role · test-isolation
│   └── lib/loadout.cjs     parser YAML + checkPath — MỘT nguồn logic ACL
└── docs/
```

## Scripts

| Lệnh | Việc |
|---|---|
| `scripts/compile-acl.sh` | sinh `.claude/settings.json` cho **mọi** vai từ `loadout.yaml` |
| `scripts/compile-acl.sh --check` | so sánh, exit 1 nếu lệch — dùng trong CI |
| `scripts/new-role.sh <slug>` | tạo vai mới + recompile ACL toàn bộ + trust workspace |
| `scripts/install-project.sh <path>` | đăng ký project code có sẵn (macOS/Linux) |
| `scripts/install-project.ps1 <path>` | đăng ký project code có sẵn (Windows PowerShell) |
| `scripts/trust-role.sh [role]` | đánh dấu workspace trusted trong `~/.claude.json` |
| `scripts/doctor.sh` | kiểm toàn vẹn: DRIFT · STALE · ORPHAN · ACL-* · TRUST-MISSING |
| `scripts/test-isolation.sh` | 20 ca cách ly (nhanh, qua hook) · `--live` chạy `claude -p` thật |
| `scripts/sync-project-index.sh --write` | sinh lại L0 từ frontmatter L1 |

## Ba điều dễ sai nhất

1. **Sửa `.claude/settings.json` bằng tay.** Nó là sản phẩm sinh ra. Sửa `loadout.yaml` rồi
   `compile-acl.sh`.
2. **Ghi fact chung vào `memory/private/`.** Fact về principal/project/thế giới luôn vào
   `shared/` hoặc `projects/`. `private/` chỉ chứa nháp.
3. **Tạo vai bằng `cp -r`.** Dùng `new-role.sh`, luôn luôn.

Chi tiết hành vi ACL đã đo thật: [`memory/shared/reference/claude-code-acl-behavior.md`](memory/shared/reference/claude-code-acl-behavior.md).
