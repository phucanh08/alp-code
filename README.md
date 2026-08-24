# alp-code

Identity + trí nhớ dùng chung cho nhiều agent. Main chạy **Claude Code** — đó là runtime
chính, vì Codex không nạp được skill `alp:plan`/`alp:cook` (marketplace của Claude Code).
Codex là **đường phụ** cho main khi muốn tiết kiệm quota. Các vai chuyên môn chạy Codex
trong phiên riêng, cùng một kho trí nhớ.

**Phở 🍜 (`main`) là coordinator mặc định, không phải cổng giao tiếp duy nhất.** Principal
có thể giao việc trực tiếp cho vai chuyên môn; phiên trực tiếp trả lời principal. Khi task
đi qua delegation, lifecycle/kết quả vẫn route về delegation parent và giữ nguyên ACL.

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

Installer clone repo về `~/.alp-code`, compile ACL cho mọi vai, trust workspace, chạy
doctor, rồi cài luôn lệnh `alp`. Cần `git` và Node >= v18.

Riêng Windows PowerShell, one-line installer thêm `%LOCALAPPDATA%\alp\bin` vào cả User
PATH lẫn PATH của terminal hiện tại. Cài xong có thể gõ `alp init` ngay; các terminal mở
sau cũng nhận lệnh `alp` ở mọi thư mục.

**Chạy lại chính lệnh đó = cập nhật** — `git pull --ff-only` rồi recompile. `memory/` không
bị đụng tới. Nhánh nội bộ đã rẽ thì installer **dừng** và báo, không tự merge hộ.

| Tuỳ chọn | bash | PowerShell |
|---|---|---|
| Đổi vị trí cài | `bash -s -- --home ~/dev/alp` hoặc `ALP_HOME=…` | `$env:ALP_HOME = "D:\alp-code"` |
| Bỏ bước trust | `bash -s -- --no-trust` | `$env:ALP_NO_TRUST = "1"` |
| Không tự sửa PATH | `bash -s -- --no-path` hoặc `ALP_NO_PATH=1` | `$env:ALP_NO_PATH = "1"` |
| Nhánh khác | `bash -s -- --branch dev` hoặc `ALP_BRANCH=…` | `$env:ALP_BRANCH = "dev"` |

> `iex` không nhận tham số dòng lệnh nên bản PowerShell chỉ đọc biến môi trường.

Đã có repo trên máy rồi thì bỏ qua installer, chạy thẳng: `scripts/bootstrap.cjs`.

- macOS / Linux / WSL: tạo symlink `~/.local/bin/alp` → `scripts/alp.cjs`, rồi thêm một
  khối có marker vào profile của zsh, bash hoặc fish nếu thư mục đó chưa có trong PATH.
- Windows: tạo `%LOCALAPPDATA%\alp\bin\alp.cmd` (không cần symlink, admin hay Developer
  Mode), rồi thêm thư mục đó vào User PATH bằng PowerShell — không dùng `setx`.

Trên macOS/Linux, installer chạy trong shell con nên terminal hiện tại không nhận PATH mới;
mở terminal mới rồi gõ `alp`. Trên Windows, lệnh `iex` chạy ngay trong PowerShell hiện tại
nên installer kích hoạt `alp` tại chỗ sau khi đã ghi User PATH. Nếu không ghi PATH được,
installer báo rõ thư mục cần thêm; `--no-path` / `ALP_NO_PATH=1` giữ nguyên cả persistent
PATH lẫn PATH của terminal hiện tại.

## Làm việc trong project của bạn

```bash
cd ~/code/my-app
alp init          # chọn delegation backend, rồi cài project
claude            # ra Phở, ngay trong my-app
```

`alp init` hỏi backend delegation mặc định trước khi đụng project. Chọn Herdr/Paseo thì ALP
kiểm CLI tương ứng, chỉ cài runtime được chọn nếu còn thiếu, khởi động server/daemon local,
kiểm adapter health rồi mới lưu lựa chọn. Herdr dùng Homebrew khi có hoặc installer chính
thức `herdr.dev`; Paseo dùng package chính thức `@getpaseo/cli`. Paseo daemon được start với
relay và MCP auto-injection tắt để role không bypass ALP policy. Trong terminal dùng `↑/↓`
để chọn, `Enter` để xác nhận; môi trường không hỗ trợ raw TTY vẫn dùng được lựa chọn `1/2`.

Sau đó `alp init` đăng ký project (project card + `workspaces` + recompile ACL), sinh
`.claude/settings.local.json` và `.codex/config.toml` **cùng từ `loadout.yaml`**, link skill,
giấu artifact khỏi `git status`, rồi **trust cả hai runtime**. Chạy lại bao nhiêu lần cũng
cho cùng kết quả. Automation/non-TTY chọn rõ backend để cho phép cài package:

```bash
alp init --backend herdr
alp init /path/to/project --backend paseo
```

Trust là bước không được bỏ: execution Claude mới có thể dừng ở dialog *"Is this
a project you trust?"* và **hook không chạy** cho tới khi trả lời — vai mở được phiên nhưng
không có danh tính, không lỗi nào nổ ra.

```bash
alp                     # phiên Phở CHỈ-ĐỌC ở thư mục bất kỳ, không cần init
alp deinit              # gỡ sạch config cục bộ, huỷ đăng ký workspace
alp doctor              # khám toàn hệ
alp update              # git pull --ff-only rồi bootstrap lại
alp help                # gom mọi script về một bảng
```

`alp` không tham số **không ghi gì** vào thư mục đó: cwd chưa đăng ký thì đúng bất biến
CHARTER — đọc được, ghi thì bị chặn (cả tool file lẫn Bash). Muốn ghi thì `alp init` trước.

`alp deinit` trả lại nguyên trạng: xoá hai file, gỡ khối exclude, rút project khỏi
`workspaces` của mọi vai rồi recompile. `git status` của project không đổi một dòng. Trí nhớ
ở `memory/projects/<slug>/` **được giữ lại** — xoá tay nếu thật sự muốn quên.

Có sẵn `.claude/settings.local.json` của riêng bạn? `alp init` cất nó thành
`settings.local.json.alp-backup` và `alp deinit` trả lại nguyên văn.

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

Delegation là kênh một agent giao việc cho agent khác. Principal vẫn có thể tương tác trực
tiếp với role/execution. Mọi request delegation đi qua `DelegationService`: ALP resolve identity, kiểm exact `delegates_to`/ACL,
build context và memory được phép, rồi mới chọn backend execution.

```bash
# API trung lập runtime
alp delegate search --project /path/to/app --background -- "Tìm luồng authentication"
alp delegate review --project /path/to/app -- "Review correctness của diff"
alp delegate oracle --project /path/to/app --background --kind claude -- "Phản biện migration"

# lifecycle dùng ALP execution ID
alp delegation status exec_...
alp delegation wait exec_...
alp delegation cancel exec_...
alp delegation cleanup exec_...

# xem/chuyển backend mặc định cho các delegation tiếp theo
alp delegation switch
alp delegation switch paseo
alp delegation switch herdr
alp delegation switch default

# compatibility facade cũ vẫn hoạt động
scripts/run-role.sh search --project /path/to/app --pane -- "Tìm luồng authentication"
scripts/run-role.sh read-thread --exec -- "Tìm các decision liên quan ACL"
```

Không truyền `--project` thì workspace là **cwd nơi bạn gõ `alp`**. Facade giữ nguyên cwd
đó khi gọi Delegation Core; prepared context pin path tuyệt đối và hook chặn execution đọc
nhầm một workspace khác đã đăng ký. Với task quan trọng, truyền `--project` để scope hiện rõ
ngay trong command/log.

Backend nền chọn ở `alp init`, `alp.config.yaml` hoặc `ALP_DELEGATION_BACKEND`; mặc định
`herdr` để giữ setup cũ. Lựa chọn persist từ `alp init`/`alp delegation switch` thắng default
này cho tới khi `switch default`, và có thể đổi sang `paseo` mà không đổi loadout, identity,
memory hay policy.
Trong Claude Code dùng `/delegation-switch paseo`; trong Codex dùng
`$delegation-switch paseo`. `--backend` vẫn là override chỉ cho một request.
`run-role --pane` nay chỉ là alias compatibility cho background execution; output công khai
dùng ALP `executionId`, không dùng pane/agent ID. Windows vẫn dùng `scripts/run-role.ps1`.
Kiến trúc, config, failure/fallback và migration: [`docs/delegation.md`](docs/delegation.md).

`alp init` cũng mở đúng `~/.alp/delegation/<repo-key>` cho main ghi lifecycle/lock và cho
Codex main kết nối backend daemon local. Quyền này không cấp cho specialist; raw
`herdr`/`paseo` vẫn bị ACL chặn.

Model, effort, sandbox và hook boot nằm trong profile `$CODEX_HOME/<role>.config.toml` do
`compile-acl.sh` sinh từ loadout — **không** truyền model bằng tay. Artifact được trả cho
main kiểm chứng và lưu.

**Sandbox.** Vai phụ **luôn** `read-only`. Riêng `main` được `workspace-write`, nhưng chỉ khi
đứng ở repo alp-code hoặc trong một đường dẫn đã khai ở `workspaces.write` — cwd lạ vẫn
`read-only`, đúng bất biến CHARTER.

**Vai phụ không spawn được vai khác.** `delegates_to` rỗng ⇒ policy từ chối trước backend.
`acl-guard` còn chặn raw `herdr`/`paseo` cho mọi role và kiểm target của `run-role`/`alp
delegate`; runtime-specific tool không phải public delegation API.

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
├── memory/                 KHÔNG commit — cục bộ từng máy, xem "Trí nhớ không đi theo git"
│   ├── INDEX.md            mục lục trí nhớ chung
│   ├── shared/             decisions · people · reference
│   ├── projects/           Project Layer 3 tầng
│   └── private/<role>/     nháp riêng, cách ly hai chiều
├── scaffold/memory/        khung RỖNG của memory/ — bootstrap chép sang cái còn thiếu
├── skills/                 skill dùng chung — nguồn sự thật DUY NHẤT của skill
│                           riêng của hệ: agent-memory (luật ghi trí nhớ) · delegation
│                           nhúng từ alp-plugin: alp-plan · alp-debug · alp-predict ·
│                           alp-scenario · code-review · docs-seeker · git · gkg ·
│                           problem-solving · repomix · research · scout · security-scan
│                           compile-acl link đúng phần `skills:` của mỗi vai sang
│                           identity/<role>/.claude/skills/ — vai không thấy skill ngoài loadout
├── hooks/                  session-start · acl-guard · session-end
├── scripts/                alp · compile-acl · new-role · doctor · trust-role · test-isolation
│   └── lib/                loadout (parser + checkPath) · claude-settings · codex-profile
│                           project-config · trust · delegation/{core,backends}
│                           — MỘT nguồn cho mỗi loại config
└── docs/
```

## Scripts

**Dùng hằng ngày — chỉ cần bảng này:**

| Lệnh | Việc |
|---|---|
| `alp` | phiên Phở chỉ-đọc ở cwd bất kỳ |
| `alp init` | chọn/cài delegation backend + đăng ký project + config/trust hai runtime |
| `alp deinit` | gỡ config cục bộ, huỷ đăng ký workspace |
| `alp delegate <role> <task>` | giao việc qua ALP policy và configured backend |
| `alp delegation <command>` | status · wait · cancel · cleanup · health · list |
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
| `scripts/run-role.sh <role> [--pane\|--exec]` | compatibility facade của Delegation API; `--release <execution-id>` = cleanup |
| `scripts/delegate.cjs <command>` | CLI Delegation API trung lập runtime |
| `scripts/trust-role.sh [role]` | đánh dấu workspace trusted trong `~/.claude.json` |
| `scripts/doctor.sh` | kiểm toàn vẹn: DRIFT · ACL-* · TRUST-* · `DELEGATION-BACKEND` · `BACKEND-HEALTH` · `ORPHAN-EXECUTION` |
| `scripts/test-communication.sh` | kiểm direct-principal channel + delegated-parent routing |
| `scripts/test-agent-routing.sh` | kiểm model, effort và delegation route của các vai Codex |
| `scripts/test-isolation.sh` | cách ly giữa các vai + chống đệ quy (nhanh, qua hook) · `--live` chạy `claude -p` thật |
| `scripts/test-delegation.cjs` | compatibility contract của launcher cũ |
| `scripts/test-delegation-core.cjs` | policy · context · registry · lifecycle bằng FakeBackend |
| `scripts/test-delegation-backends.cjs` | lifecycle mapping của HerdrBackend và PaseoBackend |
| `scripts/test-project-config.cjs` | nghiệm thu `alp init`: idempotent · uninstall sạch · cwd lạ chỉ-đọc |
| `scripts/test-runtime-installer.cjs` | prompt backend · cài/start Herdr/Paseo · non-interactive safety |
| `scripts/test-cli-link.cjs` | cài lệnh + PATH: macOS/Linux profile · Windows shim/User PATH · idempotent |
| `scripts/test-windows-installer.cjs` | one-line Windows: PowerShell 5.1/7 · không đóng host · `alp` dùng ngay |
| `scripts/test-skill-links.cjs` | symlink skill: sinh · dọn link thừa · target tương đối · validate `skills:` |
| `scripts/sync-project-index.sh --write` | sinh lại L0 từ frontmatter L1 |

## Trí nhớ không đi theo git

`memory/` nằm trong `.gitignore` — **toàn bộ**, kể cả `shared/` và `projects/`. Trí nhớ là
dữ liệu cục bộ của từng máy, không phải source code. Đồng bộ giữa nhiều máy sẽ do Agent
runtime lo ở phase sau, không phải bằng `git push`.

Hệ quả phải biết:

- **Clone sạch không có một byte trí nhớ nào.** `scripts/bootstrap.cjs` dựng lại khung từ
  `scaffold/memory/` — hai file `INDEX.md`, `README.md`, `PROTOCOL.md`, `_template/` và các
  thư mục rỗng. Nó **chỉ tạo cái còn thiếu, không bao giờ đè**.
- **Không có bản sao trên remote.** Mất `memory/` là mất thật. Muốn phòng thì backup ngoài
  git (rsync, Time Machine, thư mục cloud) — đừng gỡ dòng ignore.
- **`alp update` không đụng tới `memory/`.** Pull chỉ đổi code.

Thiếu `memory/projects/INDEX.md` thì `alp init` chết ngay ở marker `END:INDEX`, và hook
`SessionStart` boot rỗng — đó là lý do bước dựng khung chạy **trước** compile ACL.

## Ba điều dễ sai nhất

1. **Sửa `.claude/settings.json` bằng tay.** Nó là sản phẩm sinh ra. Sửa `loadout.yaml` rồi
   `compile-acl.sh`.
2. **Ghi fact chung vào `memory/private/`.** Fact về principal/project/thế giới luôn vào
   `shared/` hoặc `projects/`. `private/` chỉ chứa nháp.
3. **Tạo vai bằng `cp -r`.** Dùng `new-role.sh`, luôn luôn.

Chi tiết hành vi ACL đã đo thật: [`memory/shared/reference/claude-code-acl-behavior.md`](memory/shared/reference/claude-code-acl-behavior.md).
