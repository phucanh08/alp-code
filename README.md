# alp-code

Identity + trí nhớ dùng chung cho nhiều agent. Main có thể chạy Claude Code hoặc Codex;
các vai chuyên môn chạy trong phiên riêng và cùng một kho trí nhớ.

**Principal luôn giao tiếp qua Phở 🍜 (`main`).** Các vai chuyên môn chỉ là cơ chế
delegation nội bộ: nhận việc từ Phở, trao đổi với Phở và trả kết quả về Phở. Nếu mở trực
tiếp một vai phụ, vai đó sẽ từ chối nhiệm vụ và chuyển hướng về Phở.

Luật nền: [`CHARTER.md`](CHARTER.md). Danh bạ các vai: [`identity/REGISTRY.md`](identity/REGISTRY.md).

## Các vai hiện có

| Vai | Tên | Việc |
|---|---|---|
| `main` | Phở 🍜 | điều phối agents, vận hành project, chốt quyết định |
| `search` | Search 🔍 · GPT-5.6 Terra low | local code retrieval |
| `librarian` | Librarian 📚 · GPT-5.6 Sol | external/cross-repo research |
| `read-thread` | Read Thread 🧵 · GPT-5.6 Luna | tìm kiếm trong memory |
| `review` | Review 🔎 · GPT-5.5 medium | code review; mỗi concern là một phiên riêng |
| `oracle` | Oracle 🔮 · Opus 5 / GPT-5.6 Sol | senior consultant, second opinion tùy chọn |
| `compaction` | Compaction 🗜️ · GPT-5.6 Sol medium | context summarization cho thread dài |
| `titling` | Titling 🏷️ · GPT-5.6 Luna low | sinh nhanh một title cho thread |

## Chạy một vai

```bash
cd identity/main && claude
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

Mặc định `main`, `search` và `librarian` được đọc workspace; `read-thread` chỉ đọc
memory. `main` được ghi source. Tuỳ chỉnh bằng option lặp lại `--read-role <role>`
và `--write-role <role>`. Installer tạo project card, cập nhật L0, ghi
`workspaces.read/write` vào loadout và recompile ACL. Chạy lại cùng project là an toàn.

## Phở chạy các vai Codex

Các launcher dưới đây là công cụ delegation nội bộ cho `main`/operator, không phải các kênh
giao tiếp thay thế dành cho principal.

```bash
scripts/run-role.sh search --project /path/to/app -- "Tìm luồng authentication"
scripts/run-role.sh librarian -- "Đối chiếu API này với official docs"
scripts/run-role.sh read-thread -- "Tìm các decision liên quan ACL"
scripts/run-role.sh review --project /path/to/app -- "Review correctness của diff hiện tại"
scripts/run-role.sh oracle --project /path/to/app -- "Phản biện phương án migration này"
scripts/run-role.sh compaction -- "Tóm tắt context thread này"
scripts/run-role.sh titling -- "Đặt title cho thread này"
scripts/run-role.sh main -- "Việc cho chính Phở, chạy trên Codex"
```

Windows dùng `scripts/run-role.ps1`. Launcher chọn model + reasoning effort từ loadout;
artifact được trả cho main kiểm chứng và lưu. Oracle chạy Claude thì mở `identity/oracle`
bằng Claude Opus 5; chạy Codex thì launcher dùng GPT-5.6 Sol từ loadout.

**Sandbox.** Vai phụ **luôn** `read-only`. Riêng `main` được `workspace-write`, nhưng chỉ khi
đứng ở repo alp-code hoặc trong một đường dẫn đã khai ở `workspaces.write` — cwd lạ vẫn
`read-only`, đúng bất biến CHARTER.

**`main` trên Codex là đường phụ**, dùng khi muốn tiết kiệm quota Claude. Codex không nạp
được skill `alp:plan`/`alp:cook` (marketplace của Claude Code), nên runtime chính của main
vẫn là Claude. Model Codex của main khai riêng ở `codex_model:` trong loadout — `model:` giữ
nguyên `claude-opus-5` cho runtime chính.

## Cây thư mục

```
alp-code/
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
| `scripts/run-role.sh <role>` | chạy một vai trên Codex bằng model + effort trong loadout |
| `scripts/trust-role.sh [role]` | đánh dấu workspace trusted trong `~/.claude.json` |
| `scripts/doctor.sh` | kiểm toàn vẹn: DRIFT · STALE · ORPHAN · ACL-* · TRUST-MISSING |
| `scripts/test-communication.sh` | kiểm topology giao tiếp và contract main-only |
| `scripts/test-agent-routing.sh` | kiểm model, effort và delegation route của các vai Codex |
| `scripts/test-isolation.sh` | 20 ca cách ly (nhanh, qua hook) · `--live` chạy `claude -p` thật |
| `scripts/sync-project-index.sh --write` | sinh lại L0 từ frontmatter L1 |

## Ba điều dễ sai nhất

1. **Sửa `.claude/settings.json` bằng tay.** Nó là sản phẩm sinh ra. Sửa `loadout.yaml` rồi
   `compile-acl.sh`.
2. **Ghi fact chung vào `memory/private/`.** Fact về principal/project/thế giới luôn vào
   `shared/` hoặc `projects/`. `private/` chỉ chứa nháp.
3. **Tạo vai bằng `cp -r`.** Dùng `new-role.sh`, luôn luôn.

Chi tiết hành vi ACL đã đo thật: [`memory/shared/reference/claude-code-acl-behavior.md`](memory/shared/reference/claude-code-acl-behavior.md).
