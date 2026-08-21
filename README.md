# alp-code

Identity + trí nhớ dùng chung cho nhiều agent. Main chạy **Claude Code** — đó là runtime
chính, vì Codex không nạp được skill `alp:plan`/`alp:cook` (marketplace của Claude Code).
Codex là **đường phụ** cho main khi muốn tiết kiệm quota. Các vai chuyên môn chạy Codex
trong phiên riêng, cùng một kho trí nhớ.

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

## Cài đặt

macOS / Linux / WSL:

```bash
curl -fsSL https://raw.githubusercontent.com/phucanh08/alp-code/main/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/phucanh08/alp-code/main/install.ps1 | iex
```

Installer clone repo về `~/.alp-code`, compile ACL cho mọi vai, trust workspace, rồi chạy
`doctor.sh`. Cần `git` và Node >= v18.

**Chạy lại chính lệnh đó = cập nhật** — `git pull --ff-only` rồi recompile. `memory/` không
bị đụng tới. Nhánh nội bộ đã rẽ thì installer **dừng** và báo, không tự merge hộ.

| Tuỳ chọn | bash | PowerShell |
|---|---|---|
| Đổi vị trí cài | `bash -s -- --home ~/dev/alp` hoặc `ALP_HOME=…` | `$env:ALP_HOME = "D:\alp-code"` |
| Bỏ bước trust | `bash -s -- --no-trust` | `$env:ALP_NO_TRUST = "1"` |
| Nhánh khác | `bash -s -- --branch dev` hoặc `ALP_BRANCH=…` | `$env:ALP_BRANCH = "dev"` |

> `iex` không nhận tham số dòng lệnh nên bản PowerShell chỉ đọc biến môi trường.

Đã có repo trên máy rồi thì bỏ qua installer, chạy thẳng: `scripts/bootstrap.cjs`.

Bootstrap symlink `~/.local/bin/alp` → `scripts/alp.cjs`. Không ghi được (hoặc Windows) thì
nó in ra đường dẫn để tự thêm vào PATH — nó **không** sửa `.bashrc`/`.zshrc` hộ.

## Làm việc trong project của bạn

```bash
cd ~/code/my-app
alp init          # một lần cho mỗi project
claude            # ra Phở, ngay trong my-app
```

`alp init` làm bốn việc trong một lượt: đăng ký project (project card + `workspaces` trong
loadout + recompile ACL), sinh `.claude/settings.local.json` và `.codex/config.toml` **cùng
từ `loadout.yaml`**, giấu hai file đó khỏi `git status` bằng exclude per-clone, rồi **trust
cả hai runtime**. Chạy lại bao nhiêu lần cũng cho cùng kết quả.

Trust là bước không được bỏ: workspace chưa trust thì pane Claude mới dừng ở dialog *"Is this
a project you trust?"* và **hook không chạy** cho tới khi trả lời — vai mở được phiên nhưng
không có danh tính, không lỗi nào nổ ra.

```bash
alp                     # phiên Phở CHỈ-ĐỌC ở thư mục bất kỳ, không cần init
alp init --uninstall    # gỡ sạch config cục bộ, huỷ đăng ký workspace
alp doctor              # khám toàn hệ
alp update              # git pull --ff-only rồi bootstrap lại
alp help                # gom mọi script về một bảng
```

`alp` không tham số **không ghi gì** vào thư mục đó: cwd chưa đăng ký thì đúng bất biến
CHARTER — đọc được, ghi thì bị chặn (cả tool file lẫn Bash). Muốn ghi thì `alp init` trước.

`alp init --uninstall` trả lại nguyên trạng: xoá hai file, gỡ khối exclude, rút project khỏi
`workspaces` của mọi vai rồi recompile. `git status` của project không đổi một dòng. Trí nhớ
ở `memory/projects/<slug>/` **được giữ lại** — xoá tay nếu thật sự muốn quên.

Có sẵn `.claude/settings.local.json` của riêng bạn? `alp init` cất nó thành
`settings.local.json.alp-backup` và `--uninstall` trả lại nguyên văn.

## Chạy một vai

```bash
alp                 # Phở, chỉ-đọc, ở thư mục bất kỳ
cd ~/code/my-app && claude    # Phở, ghi được — trong project đã `alp init`
```

Hook `SessionStart` tự nạp identity. Không cần `cd` vào `identity/`, không cần đọc file
thủ công. Vai phụ thì đi qua launcher, xem [Phở giao việc](#phở-giao-việc-cho-các-vai).

> **Trust dialog:** workspace chưa trusted thì Claude Code **bỏ qua** `permissions.allow`
> và `additionalDirectories` ⇒ vai đó mở được phiên nhưng không đọc nổi `memory/`.
> `alp init` và `new-role.sh` tự trust; `alp doctor` báo `TRUST-MISSING` (Claude) và
> `TRUST-MISSING-CODEX` (Codex) nếu thiếu.

## Thêm một vai

```bash
scripts/new-role.sh qa --name QA --emoji 🧪
```

**Đây là con đường duy nhất.** Tạo thư mục bằng tay = mọi vai cũ thiếu deny cho vai mới
= rò rỉ. Xem `CHARTER.md` §4.

## Gắn một project code có sẵn

**Đường thường dùng — đứng trong project:**

```bash
cd ~/code/my-app && alp init
```

**Đường trần** — khi muốn đăng ký một project mà *không* đứng trong đó, hoặc cần đổi vai
nào được đọc/ghi:

```bash
scripts/install-project.sh /absolute/path/to/my-app --slug my-app --write-role review
.\scripts\install-project.ps1 C:\Projects\my-app --slug my-app        # Windows
```

Mặc định `main`, `search` và `librarian` được đọc workspace; `read-thread` chỉ đọc
memory. `main` được ghi source. Tuỳ chỉnh bằng option lặp lại `--read-role <role>`
và `--write-role <role>`. Installer tạo project card, cập nhật L0, ghi
`workspaces.read/write` vào loadout và recompile ACL. Chạy lại cùng project là an toàn.

`alp init` gọi thẳng installer này rồi làm thêm phần config cục bộ + trust — nên sau
`install-project.sh` trần, chạy `alp init` một lượt nữa nếu muốn gõ `claude` ngay trong repo đó.

## Phở giao việc cho các vai

Delegation nội bộ của `main`, **không** phải kênh giao tiếp thay thế cho principal.
Ba đường, chọn theo **hình dạng việc**:

| Hình dạng việc | Đường |
|---|---|
| ≥2 vai song song · >1 phút · cần theo dõi · review nhiều concern | `--pane` (**đường chính**) |
| Một câu hỏi · đồng bộ · <1 phút · hoặc không có fleet | `--exec` |
| Principal tự ngồi vào phiên đó | không cờ nào (phiên tương tác) |

```bash
# pane herdr: chạy nền, theo dõi được, không chiếm terminal
scripts/run-role.sh search --project /path/to/app --pane -- "Tìm luồng authentication"
scripts/run-role.sh review --project /path/to/app --pane -- "Review correctness của diff"
scripts/run-role.sh oracle --project /path/to/app --pane --kind claude -- "Phản biện migration"

# headless: một câu hỏi, chờ ngay tại chỗ
scripts/run-role.sh read-thread --exec -- "Tìm các decision liên quan ACL"
scripts/run-role.sh titling --exec -- "Đặt title cho thread này"

# xong việc thì trả quyền, đừng để panel kẹt `working`
scripts/run-role.sh search --release w5:p3
```

**Không có fleet ⇒ `--pane` tự rơi về `--exec`** — phiên headless không có pane để mở.
`--kind claude` chạy vai bằng Claude Code thay vì Codex (Oracle trên Opus 5).
Windows dùng `scripts/run-role.ps1`. Luật đầy đủ + ba bẫy của herdr:
[`docs/delegation.md`](docs/delegation.md).

Model, effort, sandbox và hook boot nằm trong profile `$CODEX_HOME/<role>.config.toml` do
`compile-acl.sh` sinh từ loadout — **không** truyền model bằng tay. Artifact được trả cho
main kiểm chứng và lưu.

**Sandbox.** Vai phụ **luôn** `read-only`. Riêng `main` được `workspace-write`, nhưng chỉ khi
đứng ở repo alp-code hoặc trong một đường dẫn đã khai ở `workspaces.write` — cwd lạ vẫn
`read-only`, đúng bất biến CHARTER.

**Vai phụ không spawn được vai khác.** `delegates_to` rỗng ⇒ `acl-guard` chặn `herdr` và
`run-role` ở vị trí lệnh. Không có phanh này thì Search spawn được Search.

**`main` trên Codex là đường phụ** (`scripts/run-role.sh main -- "<việc>"`), dùng khi muốn
tiết kiệm quota Claude. Model Codex của main khai riêng ở `codex_model:` trong loadout —
`model:` giữ nguyên `claude-opus-5` cho runtime chính.

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
│                           `alp init` sinh bản song sinh trong project:
│                           <project>/.claude/settings.local.json + .codex/config.toml
├── memory/
│   ├── INDEX.md            mục lục trí nhớ chung
│   ├── shared/             decisions · people · reference
│   ├── projects/           Project Layer 3 tầng
│   └── private/<role>/     nháp riêng, cách ly hai chiều
├── skills/                 agent-memory (luật ghi trí nhớ) · herdr (quản fleet)
├── hooks/                  session-start · acl-guard · session-end
├── scripts/                alp · compile-acl · new-role · doctor · trust-role · test-isolation
│   └── lib/                loadout (parser + checkPath) · claude-settings · codex-profile
│                           project-config · trust · herdr-fleet · delegation
│                           — MỘT nguồn cho mỗi loại config
└── docs/
```

## Scripts

**Dùng hằng ngày — chỉ cần bảng này:**

| Lệnh | Việc |
|---|---|
| `alp` | phiên Phở chỉ-đọc ở cwd bất kỳ |
| `alp init` | đăng ký project hiện tại + sinh config Claude/Codex + trust hai runtime |
| `alp init --uninstall` | gỡ config cục bộ, huỷ đăng ký workspace |
| `alp doctor` | khám toàn hệ — mọi tín hiệu kèm dòng `→ fix:` chạy được |
| `alp update` · `alp help` | pull + bootstrap · bảng lệnh |

**Chi tiết bên dưới** — cài đặt, bảo trì, kiểm thử:

| Lệnh | Việc |
|---|---|
| `install.sh` · `install.ps1` | cài/cập nhật bằng một dòng — clone, compile ACL, trust, doctor |
| `scripts/bootstrap.cjs` | bước sau khi có repo: compile ACL + trust + doctor (`--no-trust` để bỏ trust) |
| `scripts/compile-acl.sh` | sinh `.claude/settings.json` cho **mọi** vai từ `loadout.yaml` |
| `scripts/compile-acl.sh --check` | so sánh, exit 1 nếu lệch — dùng trong CI |
| `scripts/new-role.sh <slug>` | tạo vai mới + recompile ACL toàn bộ + trust workspace |
| `scripts/install-project.sh <path>` | đăng ký project code có sẵn (macOS/Linux) |
| `scripts/install-project.ps1 <path>` | đăng ký project code có sẵn (Windows PowerShell) |
| `scripts/run-role.sh <role> [--pane\|--exec]` | giao việc cho một vai; `--release <pane>` trả quyền khi xong |
| `scripts/trust-role.sh [role]` | đánh dấu workspace trusted trong `~/.claude.json` |
| `scripts/doctor.sh` | kiểm toàn vẹn: DRIFT · ACL-* · TRUST-MISSING\* · CODEX-PROFILE-\* · PROJECT-CONFIG-STALE · HERDR-VERSION · ORPHAN-PANE |
| `scripts/test-communication.sh` | kiểm topology giao tiếp và contract main-only |
| `scripts/test-agent-routing.sh` | kiểm model, effort và delegation route của các vai Codex |
| `scripts/test-isolation.sh` | cách ly giữa các vai + chống đệ quy (nhanh, qua hook) · `--live` chạy `claude -p` thật |
| `scripts/test-delegation.cjs` | contract ủy nhiệm · luật định tuyến pane/exec · seq |
| `scripts/test-project-config.cjs` | nghiệm thu `alp init`: idempotent · uninstall sạch · cwd lạ chỉ-đọc |
| `scripts/sync-project-index.sh --write` | sinh lại L0 từ frontmatter L1 |

## Ba điều dễ sai nhất

1. **Sửa `.claude/settings.json` bằng tay.** Nó là sản phẩm sinh ra. Sửa `loadout.yaml` rồi
   `compile-acl.sh`.
2. **Ghi fact chung vào `memory/private/`.** Fact về principal/project/thế giới luôn vào
   `shared/` hoặc `projects/`. `private/` chỉ chứa nháp.
3. **Tạo vai bằng `cp -r`.** Dùng `new-role.sh`, luôn luôn.

Chi tiết hành vi ACL đã đo thật: [`memory/shared/reference/claude-code-acl-behavior.md`](memory/shared/reference/claude-code-acl-behavior.md).
