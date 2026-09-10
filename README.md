# alp-code

ALP là launcher code-native cho một nhóm agent dùng chung policy, workflow và memory. Mỗi
execution nhận một `AgentDefinition` bất biến, policy snapshot và identity capsule trước khi
được chuyển thành lệnh Claude Code hoặc Codex. Runtime chỉ chạy launch spec; lifecycle do
ALP tự quản bằng child process. Runtime không phải nguồn sự thật của identity hay quyền.

Phở 🍜 (`main`) là coordinator mặc định. Principal có thể chọn Claude hoặc Codex cho phiên
main; specialist luôn đi qua `DelegationService` và chỉ nhận đúng workspace/memory/tool grant
đã được policy duyệt.

## Agent hiện có

| Role | Trách nhiệm |
|---|---|
| `main` | điều phối, thực thi trong project đã đăng ký, tổng hợp kết quả |
| `search` | local code retrieval |
| `librarian` | external/cross-repo research |
| `read-thread` | tìm kiếm trong memory |
| `review` | code review theo concern |
| `oracle` | second opinion sâu |
| `compaction` | context summarization |
| `titling` | sinh title ngắn |

Definitions nằm trong `src/agents/`; registry kiểm uniqueness, quan hệ, tools, memory và
workspace grants khi load. `PolicyEngine` fail-closed trước mọi delegation, memory operation,
workspace access và tool request.

## Cài đặt

Direct binary là channel mặc định; không cần Node, Bun, npm, Git hay bước build nào trên máy
người dùng. Installer nhận diện OS/CPU/libc, tải đúng archive và `SHA256SUMS`, kiểm digest +
manifest + staged smoke trước khi đổi `current`:

```bash
curl -fsSL https://raw.githubusercontent.com/phucanh08/alp-code/main/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/phucanh08/alp-code/main/install.ps1 | iex
```

Archive chứa binary, `skills/`, `scaffold/`, legacy hooks và license. Các version nằm bất biến
ở `~/.alp-code/versions/vX.Y.Z`; `current` được thay atomically và lệnh ổn định nằm ở
`~/.alp-code/bin/alp` (Windows dùng `current\bin\alp.exe`). `~/.alp` là user state riêng,
không nằm trong vùng installer/update thay thế.

npm vẫn được hỗ trợ như một wrapper channel cho môi trường đã có Node >=18:

```bash
npm i -g alp-code
```

Package npm chỉ chứa downloader/launcher nhỏ. Lần cài hoặc lần chạy đầu tải archive đúng bằng
version của package vào cache per-user; không dùng `/latest`. Vì launcher tự bảo đảm payload,
`npm i -g alp-code --ignore-scripts` cũng hoạt động.

| Tuỳ chọn | bash | PowerShell |
|---|---|---|
| Ép channel | `bash -s -- --channel binary|npm|dev` hoặc `ALP_CHANNEL=…` | `$env:ALP_CHANNEL = "binary"` |
| Ghim một phiên bản | `bash -s -- --version v0.10.0` hoặc `ALP_VERSION=…` | `$env:ALP_VERSION = "v0.10.0"` |
| Đổi vị trí cài | `bash -s -- --home ~/dev/alp` hoặc `ALP_HOME=…` | `$env:ALP_HOME = "D:\alp-code"` |
| Không sửa PATH | `bash -s -- --no-path` hoặc `ALP_NO_PATH=1` | `$env:ALP_NO_PATH = "1"` |
| Dev clone theo nhánh | `bash -s -- --branch dev` hoặc `ALP_BRANCH=…` | `$env:ALP_BRANCH = "dev"` |

`--branch` chọn dev clone và là đường duy nhất còn build tại máy.

Build matrix tạo archive cho macOS arm64/x64, Linux glibc x64/arm64 và Windows x64. Chỉ target
đã chạy xanh trên host đúng kiến trúc trong workflow release mới được quảng bá stable; evidence
local hiện có cho darwin-arm64, các target còn lại chờ CI. Linux musl, Windows arm64 và
notarization chưa thuộc v0.10.

### Cập nhật

`alp update` đi theo channel của bản cài:

| Channel | Cách nhận diện | `alp update` làm gì |
|---|---|---|
| `binary` | manifest trong `~/.alp-code/versions/<tag>` | tải archive + checksum, smoke, rồi atomically đổi `current` |
| `npm` | wrapper truyền metadata đã khóa version | `npm install -g alp-code@<version>`; wrapper lấy payload cùng version |
| `dev` | có `.git` và `src/` | checkout tag release mới nhất rồi build lại |

Không còn bước backup/restore dữ liệu nào trong update. Từ v0.9.0 mọi thứ thuộc về bạn — memory,
nấc đã chọn, execution state, project registry — nằm ở `~/.alp`, còn thư mục cài là artifact
thay được nguyên khối. Bản cài cũ hơn được di trú tự động ở lần chạy `alp` đầu tiên.

Riêng dev clone vẫn dừng khi có staged/tracked change chưa commit: ALP không merge hay clobber
source của bạn.

Các lệnh đầy đủ kiểm tra ngầm xem có bản release mới không, dùng
cache tại `~/.alp/update-check.json` với TTL 24h — việc kiểm tra không bao giờ chặn lệnh hiện
tại. Nếu có bản mới, ALP chỉ in một dòng gợi ý `alp update`; nó không tự cập nhật hay hỏi lại.
Đặt `ALP_SKIP_UPDATE_CHECK=1` để tắt hẳn (hữu ích cho môi trường test/CI cô lập).
`alp --version` và `alp hook …` rẽ nhánh trước state/registry/update check.

## Bắt đầu một project

```bash
cd ~/code/my-app
alp init                        # đăng ký project hiện tại
alp                             # chọn nấc tương tác (menu ↑/↓)
alp --mode high
alp --mode puck
```

Nấc (`low` · `medium` · `high` · `ultra` · `puck`) là lựa chọn duy nhất lúc mở phiên: nó ghim
đúng **một** model cho từng vai, và model quyết định CLI nào chạy vai đó (`claude-*` → Claude
Code, `gpt-*` → Codex). Không có `--runtime`; bốn nấc đầu xếp theo độ khó của việc, `puck`
chạy toàn Codex. Xem bảng model từng nấc ở `docs/architecture.md` §4.1.

`alp init` canonicalize và đăng ký project trong `~/.alp/projects.json`, sinh lại tài liệu
identity trong `.alp/agents/`, rồi ghi
`<project>/.claude/settings.local.json` chỉ chứa hook `SessionStart`. Hook đó nạp identity
của vai vào context ngay turn đầu — mở `claude` bằng tay trong project cũng có identity mà
không tốn một lượt gọi tool. Command bền vững là `alp hook session-boot`; state migration sửa
entry `hooks/session-boot.cjs` cũ trong project. `alp init` cũng link từng packaged skill vào
`.claude/skills` và `.agents/skills` qua asset root ổn định, nên đổi `current` không làm link
chết. `alp deinit` xoá lại đúng phần ALP sở hữu (nhận diện qua marker
`alp init`) và phục hồi backup nếu bạn đã có file riêng.

File đó được ghi vào `.git/info/exclude` của chính clone — per-clone, không commit — nên
`git status --porcelain` vẫn không đổi và cộng tác viên khác không thấy gì.

Lần `alp init` đầu tiên trên máy, khi `~/.alp/principal.json` chưa có và đang chạy trên TTY,
ALP hỏi ba câu: tên bạn, agent gọi bạn là gì, agent tự xưng là gì. Câu trả lời đi thẳng vào
dòng đầu prompt của mọi vai. Không có TTY (CI, script) thì init vẫn chạy tiếp với bản trung
tính và in một dòng gợi ý — ALP không đoán tên từ `git config`. Xem hoặc đổi lúc nào cũng
được:

```bash
alp principal show
alp principal set                # ghi đè, rồi sinh lại .alp/agents/
```

Khi sửa `src/agents/`, chạy lại `alp identity sync` để tài liệu phẳng khớp registry:

```bash
alp identity sync
```

Project đã đăng ký cho phiên `main` quyền `workspace-write`; cwd chưa đăng ký là
`read-only`. `alp deinit` gỡ registration và dọn artifact cũ do các bản ALP trước tạo ra,
nhưng không xoá memory của project.

Nấc dùng cho phiên main nhớ được giữa các lần chạy (`~/.alp/mode.json`):

```bash
alp mode show
alp mode set high
```

Thứ tự quyết định: `--mode` → `ALP_MODE` → `alp mode set` → menu trên TTY → `medium`.

## Kiểm tra một agent

```bash
alp agent test review                 # ba tầng, dừng ở tầng đỏ đầu tiên
alp agent test --all                  # cả 8 vai built-in + custom agent của project
alp agent test main --tier 2 --mode high
alp agent test migrator --project ~/code/app
alp agent test search --json          # cùng nội dung, cho script đọc
```

Ba tầng, rẻ trước đắt sau, không tầng nào gọi model:

| Tầng | Kiểm gì |
|---|---|
| 1 · static | grant so với catalog, workflow reachable + có trạng thái kết thúc, skill có thật trên đĩa và không symlink ra ngoài skill root, model có runtime, ngưỡng auto-compact so với cửa sổ context |
| 2 · dry-run prepare | chạy `ExecutionService.prepare` thật rồi dừng **trước** spawn; in quyền (bảng Authority đúng như vai sẽ đọc), egress (tool ra mạng, MCP server và lệnh của nó) và chi phí (nấc chọn runtime nào, model, ngưỡng nén, byte SKILL.md vào context), kèm launch spec của cả hai runtime để diff cạnh nhau |
| 3 · deny path | từng trần capability phải từ chối bằng **đúng mã lỗi** — `TOOL_NOT_GRANTED`, `WORKSPACE_SCOPE_MISMATCH`, `PRIVATE_MEMORY_DENIED`… — chứ không chỉ "thất bại" |

Mọi thứ tầng 2 ghi ra nằm trong một thư mục tạm và bị xoá sau đó: memory, execution state, file
cấu hình runtime. Không có tiến trình runtime nào được phóng. Exit `0` khi sạch, `1` khi có
finding — cùng quy ước với `alp doctor`.

Dừng ở tầng đỏ đầu tiên là có chủ ý: một definition hỏng ở tầng 1 sẽ làm snapshot tầng 2 mô tả
trung thực một thứ đã sai, còn tầng 3 từ chối đúng vì lý do sai.

## Custom agent (đang mở dần)

Principal viết thêm agent cho một project bằng dữ liệu, không phải TypeScript, ở
`<project>/.alp/agents/<id>/agent.yaml`:

```yaml
schemaVersion: 1
id: migrator
displayName: "Migrator 🔧"

model:           { claude: claude-opus-5, codex: gpt-5.6-terra }
reasoningEffort: { claude: high, codex: medium }

instructions:
  role: "Migrator, the framework migration specialist"
  purpose: "Migrate one module per execution and prove the migration with tests."
  houseRules: code-native+craft        # none | code-native | code-native+craft
  rules:
    - "Never migrate more than one module per execution."

capabilities:
  tools: [Read, Glob, Grep, Bash, Skill]
  skills: [git, problem-solving]       # skill built-in, khai bằng tên trong catalog
  memory:
    read:  [shared, "project:*", "private:migrator"]
    write: ["private:migrator"]
  workspace:
    readRoots: ["."]

workflow:
  - { id: ASSESS,  allowedTools: [Read, Glob, Grep] }
  - { id: REPORT,  allowedTools: [] }

output:
  kind: text
```

Trần capability cưỡng chế lúc load, mỗi thứ đều fail-closed:

| Trường | Trần |
|---|---|
| `reportsTo` / `delegatesTo` | ép `main` / ép rỗng — không khai được, custom agent là lá |
| `tools` | ⊆ `TOOL_CATALOG` **và** ⊆ tool của `main` |
| `skills` | **chỉ** skill built-in, tên phải có trong `SKILL_CATALOG`. Skill của project khai bằng thư mục, xem dưới |
| `subagents` · `mcpServers` | khai bằng **tên** trong catalog — cả hai catalog đang rỗng nên mọi grant đều bị từ chối |
| `memory.write` | chỉ `private:<id>` |
| `memory.read` | `shared`, `shared:*`, `project:*`, `private:<id>` |
| `workspace.readRoots` | đường dẫn tương đối, không ra khỏi project |
| `workspace.writeRoots` | rỗng, tới khi có approval (§6) |
| `houseRules` | chọn từ tập dựng sẵn; bỏ trống nhận `code-native` chứ không phải `none` |
| `rules` | ≤ 20 rule, mỗi rule ≤ 240 ký tự |
| `output` | chỉ `kind: text` |
| `id` | kebab-case, không đụng id built-in, phải trùng tên thư mục |

Parser chạy trên file untrusted nên tắt sẵn những tiện nghi cũng là lỗ hổng: không anchor/alias
(chặn YAML bomb), key trùng bị từ chối, multi-document bị từ chối, giới hạn 32 KiB trước khi
parse, key lạ bị từ chối chứ không bỏ qua.

### Skill của project

Skill riêng của project không khai trong `agent.yaml` — **thư mục chính là danh sách grant**:

```text
<project>/.alp/
├── skills/
│   └── house-conventions/SKILL.md          # dùng chung cho project
└── agents/migrator/
    ├── agent.yaml
    └── skills/
        ├── framework-migration/SKILL.md    # thư mục thật: chỉ migrator thấy
        ├── house-conventions -> ../../../skills/house-conventions
        └── release-drill.skillref          # một dòng: ../../../skills/release-drill
```

`.skillref` tồn tại cho Windows không bật developer mode và cho checkout git không giữ symlink.

Hai đường khai skill vì chúng diễn đạt hai thứ khác nhau, không phải hai cách nói cùng một
thứ: skill built-in nằm ở `~/.alp-code/versions/<tag>/skills` — thư mục `alp update` thay
nguyên khối — nên không link tương đối tới được, phải gọi bằng tên; skill của project đi cùng
repo qua git nên phải là đường dẫn. Cùng một tên xuất hiện ở cả hai chỗ thì loader từ chối.

Luật escape, cưỡng chế lúc load, áp cho cả symlink lẫn `.skillref`: đích phải nằm trong
`.alp/skills/` hoặc cây skill built-in, đi theo link đúng **một** cấp, và vượt ra ngoài thì
**deny cả agent** chứ không bỏ qua riêng link đó. Skill root là một quyền đọc — một link trỏ ra
`~/.ssh` sẽ biến "được đọc skill của mình" thành "được đọc bất cứ đâu" trong khi
`workspace.readRoots` vẫn nói khác. Trần: 20 skill mỗi agent.

Thứ tự resolve, **cụ thể thắng chung** — `code-review` của project che `code-review` built-in
cho đúng vai đó và không ảnh hưởng vai khác:

```bash
alp agent show review          # in thứ tự đã tính, và từng binding resolve tới đâu
```

Vai built-in cũng nhận được skill của project qua **cùng một cơ chế**: một thư mục
`.alp/agents/review/skills/` không có `agent.yaml` là overlay. Nó chỉ thêm skill — có
`agent.yaml` cạnh một id built-in là deny, và overlay đặt lên vai không có tool `Skill` cũng bị
từ chối. Overlay chưa trust thì vai built-in vẫn chạy với skill shipped của nó, chỉ mất phần
thêm.

### Trust

Một file trong repo chưa phải một agent chạy được. Nó phải được principal duyệt:

```bash
alp agent list                  # file nào có, cái nào phiên chạy tới được
alp agent show migrator         # quyền, trust status, thứ tự resolve skill
alp agent add migrator          # chạy đủ ba tầng, in quyền, rồi hỏi
alp agent untrust migrator      # thu lại
```

`alp agent add` làm ba việc trước khi hỏi, theo đúng thứ tự đó: loader phải nhận file (vượt trần
thì không phải quyết định trust, mà là file hỏng), cả **ba tầng phải xanh** (agent không qua nổi
deny-path test của chính nó thì trần của nó là lời hứa chứ không phải kiểm tra), rồi in trọn
quyền · egress · chi phí, kèm **diff capability** nếu file này từng được trust với nội dung khác.

Chỉ terminal mới trả lời được — **không có `--yes`**. Một cờ duyệt quyền mà không có người đọc
biến cả cái cổng thành thủ tục, và chỗ duy nhất người ta dùng nó (script, CI) đúng là chỗ không
ai đọc.

Duyệt xong, hash của definition nằm ở `~/.alp/trusted-agents.json` (0600), khoá theo **cả project
lẫn id** — hai repo cùng có `migrator` là hai quyết định khác nhau. Từ lúc đó `main` delegate
tới nó được, và tập agent đã trust đi vào `policyHash` của `main` chứ không nằm riêng một chỗ.

Sửa file sau khi trust là **deny**, không phải cảnh báo:

```
CHANGED    migrator   edited since it was trusted — denied until `alp agent add` approves it again
```

Cảnh báo sẽ đẩy quyết định về cho người đang nhìn terminal lúc đó — đúng khoảnh khắc mà một file
agent bị sửa đang trông chờ. Phiên chạy vẫn in một dòng nói rõ vì sao vai đó biến mất, vì im lặng
thì không phân biệt được với một lỗi của ALP.

## Delegation

```bash
alp delegate search --project /path/to/app --background -- "Find auth entrypoint"
alp delegate review --project /path/to/app -- "Review the current diff"

alp delegation status exec_...
alp delegation wait exec_...
alp delegation cancel exec_...
alp delegation cleanup exec_...
```

Luồng bắt buộc:

```text
caller role
  -> DelegationService
  -> AgentRegistry + PolicyEngine + MemoryService + ExecutionService
  -> RuntimeAdapter (Claude/Codex launch spec)
  -> ExecutionBackend (child-process lifecycle)
```

Unauthorized delegation bị từ chối trước runtime probe hay spawn. Backend spawn runtime làm
child process kèm settings file riêng của vai, nên `permissions.deny` là ràng buộc thật chứ
không phải khuyến nghị; state nằm trong `local.json` dưới delegation state dir để một CLI
process sau vẫn chạy được lệnh lifecycle. `scripts/run-role.cjs` và `scripts/delegate.cjs`
chỉ là compatibility wrappers vào cùng code-native service.

## Memory

Agent chỉ dùng `MemoryService`/`MemoryStore` với logical ID:

```text
shared:<id>
project:<slug>:<id>
private:<role>:<id>
```

Hiện `MarkdownFileStore` lưu body Markdown dưới `~/.alp/memory` (`ALP_MEMORY_ROOT` để đổi chỗ).
`RemoteApiStore` triển khai cùng
contract qua một `MemoryApiClient` injected, để tương lai chuyển sang server mà không đổi
agent logic. Policy authorize trước mọi store call; optimistic versioning và audit metadata
được giữ ở service boundary.

Memory nằm NGOÀI thư mục cài, vì thư mục cài bị thay nguyên khối mỗi lần update. Bootstrap chỉ
chép phần scaffold còn thiếu và không bao giờ ghi đè nội dung. `alp uninstall` mặc định chuyển
toàn bộ memory sang backup cạnh `~/.alp`; chỉ `--purge-memory` mới xoá nó.

## Continuity qua compaction

Claude Code và Codex CLI tự nén (compact) transcript của chính chúng khi hết context. ALP giữ
một checkpoint nhỏ ở ngoài — objective và các quyết định/ràng buộc đã pin — và trả nó lại ngay
sau lần compact kế tiếp, không copy native summary, không synthetic turn:

```bash
alp context status                  # objective, số pin, generation, restore mode
alp context pin decision -- "chose X over Y because Z"
alp context pin constraint -- "do not touch Z"
alp context validate                # kiểm checkpoint + journal
```

`alp context pin`/`unpin` chạy được cả từ CLI của principal lẫn từ trong một phiên agent (nó
đọc `ALP_DELEGATION_EXECUTION_ID` từ môi trường). Tắt hoàn toàn bridge bằng cách không đặt
`ALP_COMPACT_BRIDGE=1` — checkpoint và continuity vẫn được seed/reinject bình thường, chỉ riêng
việc ghi journal lúc `PreCompact`/`PostCompact` là opt-in. Đừng pin secret hay nội dung file:
pin đọc lại được bằng `cat` và reinject thẳng vào context window của model.

## Bảo trì

| Lệnh | Việc |
|---|---|
| `alp doctor [--quiet]` | manifest/target/current/stable command, registry, runtime CLIs, memory và execution state |
| `alp update` | cập nhật theo channel (binary / npm / dev); dữ liệu ở `~/.alp` không bị đụng |
| `alp --version` | in build-time version, không network hay dựng state |
| `alp uninstall [--purge-memory] [--force]` | gỡ bản cài theo channel; backup memory mặc định; trong `~/.alp` chỉ xoá thứ của alp-code |
| `scripts/bootstrap.cjs [--no-path]` | dựng state, validate, doctor, link CLI (build chỉ với dev clone) |
| `scripts/ensure-state.cjs [--quiet]` | dựng lại `~/.alp` và hook forwarder cho bản cài hiện hành |

Doctor exit `0` khi healthy, `1` khi có finding cần xử lý, `2` khi doctor tự lỗi. Mỗi finding
có remediation cụ thể. Cutover đã hoàn tất, nên `STALE-LEGACY` chỉ xuất hiện khi máy còn sót
artifact của bản ALP cũ (`identity/`, `CHARTER.md`, compiled ACL); doctor sẽ chỉ cách dọn.

### Cắt bản release (cho maintainer)

1. Viết mục `[Chưa phát hành]` trong `CHANGELOG.md` cho bản này.
2. `node scripts/cut-release.cjs <patch|minor|major|X.Y.Z>` — bump `package.json.version`,
   đóng mục CHANGELOG theo ngày, tạo commit `chore(release): vX.Y.Z` và tag. Thêm
   `--dry-run` để xem trước. Script cố ý dừng trước push.
3. `git push origin main --tags`.
4. `node scripts/pack-release.cjs` — dựng wrapper-only `.tgz`, năm native archive và
   `SHA256SUMS` vào `build/release/`. Script kiểm nội dung rồi cố ý dừng trước khi đẩy đi.
5. `npm publish build/alp-code-X.Y.Z.tgz`.
6. Sau khi target matrix xanh, tạo GitHub Release và upload năm archive cùng `SHA256SUMS`.
   Publish/upload luôn là bước riêng cần principal duyệt; workflow build/test không tự phát hành.
7. Từ đây `npm i -g alp-code`, installer và `alp update` trên máy khác đều thấy `vX.Y.Z`.

## Cấu trúc

```text
src/
  agents/       immutable AgentDefinition registry
  agents/loader/ đọc `.alp/agents/<id>/agent.yaml` và cưỡng chế trần capability
  trust/        hash pin, capability diff và registry theo từng project
  agent-test/   ba tầng của `alp agent test` (static, dry-run prepare, deny path)
  policy/       delegation, tool, memory và workspace authorization
  memory/       storage-neutral service + Markdown/remote adapters
  execution/    identity capsules, policy snapshots, execution state
  workflow/     state machine và output validation/repair
  context/      cross-runtime compact bridge (checkpoint, journal, continuity render)
  runtime/      Claude/Codex launch-spec adapters
  backend/      runtime-neutral execution lifecycle (child process + supervisor)
  delegation/   request normalization, execution tracking, result routing
  cli/          alp commands và mode selection
scripts/        stable CJS wrappers, maintenance, installers và compatibility tests
hooks/          execution-policy/workflow bridges
scaffold/       memory skeleton cho clean install
test/           Vitest unit, contract, integration và E2E suites
```

## Kiểm thử

```bash
npm run typecheck
npm run build
npm test

for f in scripts/test-*.cjs; do node "$f" || break; done
```

`npm test` chạy unit, contract, integration và E2E. Năm suite E2E (`test/e2e/`) dựng fake
runtime binaries cho `claude`/`codex` để kiểm launch contract, delegation, memory isolation,
mode selection và compact bridge (pin → fixture compaction → reinject) mà không gọi model
trả phí. Mười hai script `scripts/test-*.cjs` giữ phần
cross-platform: CLI link, Codex role, delegation, execution hooks, installer (POSIX và
Windows), state `~/.alp`, nội dung artifact phát hành, update và uninstall — trong đó
uninstall có process-level fixture để chứng minh CLI vẫn hoàn tất sau khi xoá installation
đang chứa code của chính nó.

## Guardrails

- Không gọi raw Herdr/Paseo hoặc in-process subagent để bypass ALP.
- Unknown tool/path/role/request luôn bị từ chối.
- Private memory chỉ role sở hữu được đọc.
- Không sửa agent definition/policy source từ một delegated execution.
- Không commit, push, deploy hay purge memory nếu principal chưa yêu cầu rõ.

## Giấy phép

[MIT](LICENSE) © 2026 Phúc Anh. Giấy phép đi kèm trong cả hai artifact phát hành — bản npm và
bundle tarball — nên bản cài nào cũng tự nói được điều kiện dùng của nó.
