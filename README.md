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

```bash
npm i -g alp-code
```

Cần Node.js >= 18. Không cần Git, không cần build: bản phát hành đã mang sẵn `dist/`, máy bạn
chỉ giải nén và chạy.

Máy không có npm, hoặc registry bị chặn — installer tải thẳng bundle của GitHub Release:

```bash
curl -fsSL https://raw.githubusercontent.com/phucanh08/alp-code/main/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/phucanh08/alp-code/main/install.ps1 | iex
```

Installer tự chọn channel: có `npm` thì cài qua npm; không thì tải
`alp-code-<tag>-bundle.tar.gz` về `~/.alp-code/versions/<tag>` và trỏ symlink
`~/.alp-code/current` vào đó. Hai channel cho ra cùng một cây file — khác nhau chỉ ở ai sở hữu
thư mục cài. Sau đó nó gọi `scripts/bootstrap.cjs` để:

1. dựng `~/.alp` (memory, hook forwarder, install record) mà không ghi đè dữ liệu sẵn có;
2. validate `AgentRegistry` và hai runtime adapter;
3. chạy doctor;
4. cài lệnh `alp` vào PATH — bản npm bỏ qua bước này vì npm đã làm rồi.

| Tuỳ chọn | bash | PowerShell |
|---|---|---|
| Ép channel | `bash -s -- --channel tarball` hoặc `ALP_CHANNEL=…` | `$env:ALP_CHANNEL = "tarball"` |
| Ghim một phiên bản | `bash -s -- --version v0.9.0` hoặc `ALP_VERSION=…` | `$env:ALP_VERSION = "v0.9.0"` |
| Đổi vị trí cài (tarball) | `bash -s -- --home ~/dev/alp` hoặc `ALP_HOME=…` | `$env:ALP_HOME = "D:\alp-code"` |
| Không sửa PATH | `bash -s -- --no-path` hoặc `ALP_NO_PATH=1` | `$env:ALP_NO_PATH = "1"` |
| Dev clone theo nhánh | `bash -s -- --branch dev` hoặc `ALP_BRANCH=…` | `$env:ALP_BRANCH = "dev"` |

`--branch` là channel thứ ba: clone repo và build tại chỗ. Đó là đường duy nhất còn build trên
máy người dùng, và chỉ dành cho người phát triển chính ALP.

### Cập nhật

`alp update` đi theo channel của bản cài:

| Channel | Cách nhận diện | `alp update` làm gì |
|---|---|---|
| `npm` | thư mục cài nằm dưới một `node_modules/` | `npm install -g alp-code@<version>` |
| `tarball` | còn lại, thường `~/.alp-code/versions/<tag>` | tải bundle mới, giải nén sang `versions/<tag>` rồi mới đổi `current` |
| `dev` | có `.git` và `src/` | checkout tag release mới nhất rồi build lại |

Không còn bước backup/restore dữ liệu nào trong update. Từ v0.9.0 mọi thứ thuộc về bạn — memory,
nấc đã chọn, execution state, project registry — nằm ở `~/.alp`, còn thư mục cài là artifact
thay được nguyên khối. Bản cài cũ hơn được di trú tự động ở lần chạy `alp` đầu tiên.

Riêng dev clone vẫn dừng khi có staged/tracked change chưa commit: ALP không merge hay clobber
source của bạn.

Mỗi lần chạy `alp` (bất kỳ lệnh nào), ALP kiểm tra ngầm xem có bản release mới không, dùng
cache tại `~/.alp/update-check.json` với TTL 24h — việc kiểm tra không bao giờ chặn lệnh hiện
tại. Nếu có bản mới, ALP chỉ in một dòng gợi ý `alp update`; nó không tự cập nhật hay hỏi lại.
Đặt `ALP_SKIP_UPDATE_CHECK=1` để tắt hẳn (hữu ích cho môi trường test/CI cô lập).

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
không tốn một lượt gọi tool. `alp deinit` xoá lại đúng file đó (nhận diện qua marker
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
| `alp doctor [--quiet]` | registry, runtimes, memory, execution state, stale legacy, build drift |
| `alp update` | cập nhật theo channel (npm / tarball / dev clone); dữ liệu ở `~/.alp` không bị đụng |
| `alp --version` | in phiên bản đang cài (đọc `package.json`) |
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
4. `node scripts/pack-release.cjs` — dựng hai artifact vào `build/`: `.tgz` cho npm và
   `alp-code-vX.Y.Z-bundle.tar.gz` (kèm sẵn dependency runtime) cho GitHub Release. Script
   kiểm nội dung artifact rồi cố ý dừng trước khi đẩy đi.
5. `npm publish build/alp-code-X.Y.Z.tgz`.
6. `gh release create vX.Y.Z --generate-notes` rồi
   `gh release upload vX.Y.Z build/alp-code-vX.Y.Z-bundle.tar.gz` — publish từ máy, biết kết
   quả ngay. Repo cố ý không dùng GitHub Actions cho việc này; lý do ghi trong
   `.claude/skills/release/SKILL.md`.
7. Từ đây `npm i -g alp-code`, installer và `alp update` trên máy khác đều thấy `vX.Y.Z`.

## Cấu trúc

```text
src/
  agents/       immutable AgentDefinition registry
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
