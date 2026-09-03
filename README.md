# alp-code

ALP là launcher code-native cho một nhóm agent dùng chung policy, workflow và memory. Mỗi
execution nhận một `AgentDefinition` bất biến, policy snapshot và identity capsule trước khi
được chuyển thành lệnh Claude Code hoặc Codex. Runtime chỉ chạy launch spec; Paseo/local chỉ
quản lifecycle. Không runtime/backend nào là nguồn sự thật của identity hay quyền.

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

macOS / Linux / WSL:

```bash
curl -fsSL https://raw.githubusercontent.com/phucanh08/alp-code/main/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/phucanh08/alp-code/main/install.ps1 | iex
```

Installer cần Git và Node.js >= 18. Mặc định nó clone rồi resolve tag GitHub Release mới nhất
(`api.github.com/repos/.../releases/latest`, fallback `git ls-remote --tags` khi API không tới
được) và checkout đúng tag đó, trước khi gọi `scripts/bootstrap.cjs` để:

1. dựng phần memory/state còn thiếu mà không ghi đè dữ liệu;
2. chạy `npm ci --include=dev` và build TypeScript;
3. validate `AgentRegistry` và hai runtime adapter;
4. chạy doctor;
5. cài lệnh `alp` vào PATH.

| Tuỳ chọn | bash | PowerShell |
|---|---|---|
| Đổi vị trí cài | `bash -s -- --home ~/dev/alp` hoặc `ALP_HOME=…` | `$env:ALP_HOME = "D:\alp-code"` |
| Không sửa PATH | `bash -s -- --no-path` hoặc `ALP_NO_PATH=1` | `$env:ALP_NO_PATH = "1"` |
| Ghim một phiên bản | `bash -s -- --version v0.2.0` hoặc `ALP_VERSION=…` | `$env:ALP_VERSION = "v0.2.0"` |
| Theo dõi một nhánh (dev, bỏ qua release) | `bash -s -- --branch dev` hoặc `ALP_BRANCH=…` | `$env:ALP_BRANCH = "dev"` |

Chạy lại installer hoặc `alp update` sẽ resolve + checkout tag GitHub Release mới nhất rồi
rebuild. Update backup và khôi phục nguyên trạng `memory/`, runtime preference và backend
preference. Staged/tracked change chưa commit làm update dừng; ALP không tự merge hay clobber
source. Đặt `--branch`/`ALP_BRANCH` để theo dõi trực tiếp một nhánh thay vì release (chỉ dùng
khi phát triển) — khi đó `alp update` quay lại hành vi fast-forward pull như cũ.

Mỗi lần chạy `alp` (bất kỳ lệnh nào), ALP kiểm tra ngầm xem có bản release mới không, dùng
cache tại `~/.alp/update-check.json` với TTL 24h — việc kiểm tra không bao giờ chặn lệnh hiện
tại. Nếu có bản mới, ALP chỉ in một dòng gợi ý `alp update`; nó không tự cập nhật hay hỏi lại.
Đặt `ALP_SKIP_UPDATE_CHECK=1` để tắt hẳn (hữu ích cho môi trường test/CI cô lập).

## Bắt đầu một project

```bash
cd ~/code/my-app
alp init --backend paseo        # hoặc local
alp                             # chọn runtime tương tác
alp --runtime claude
alp --runtime codex
```

`alp init` canonicalize và đăng ký project trong `~/.alp/projects.json` (kèm backend nếu
được chọn), sinh lại tài liệu identity trong `.alp/agents/`, rồi ghi
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

Runtime preference độc lập với backend preference:

```bash
alp runtime show
alp runtime set codex
alp delegation switch local
alp delegation switch paseo
alp delegation switch default
```

## Delegation

```bash
alp delegate search --project /path/to/app --runtime codex --background -- "Find auth entrypoint"
alp delegate review --project /path/to/app -- "Review the current diff"

alp delegation status exec_...
alp delegation wait exec_...
alp delegation cancel exec_...
alp delegation cleanup exec_...
alp delegation health
```

Luồng bắt buộc:

```text
caller role
  -> DelegationService
  -> AgentRegistry + PolicyEngine + MemoryService + ExecutionService
  -> RuntimeAdapter (Claude/Codex launch spec)
  -> ExecutionBackend (local/Paseo lifecycle)
```

Unauthorized delegation bị từ chối trước runtime probe, backend health hay spawn. Backend
được pin vào execution record; fallback chỉ hợp lệ trước spawn. `scripts/run-role.cjs` và
`scripts/delegate.cjs` chỉ là compatibility wrappers vào cùng code-native service.

## Memory

Agent chỉ dùng `MemoryService`/`MemoryStore` với logical ID:

```text
shared:<id>
project:<slug>:<id>
private:<role>:<id>
```

Hiện `MarkdownFileStore` lưu body Markdown dưới `memory/`. `RemoteApiStore` triển khai cùng
contract qua một `MemoryApiClient` injected, để tương lai chuyển sang server mà không đổi
agent logic. Policy authorize trước mọi store call; optimistic versioning và audit metadata
được giữ ở service boundary.

`memory/` không đi theo Git. Bootstrap chỉ chép scaffold còn thiếu. `alp uninstall` mặc
định chuyển toàn bộ memory sang backup cạnh installation; chỉ `--purge-memory` mới xoá nó.

## Bảo trì

| Lệnh | Việc |
|---|---|
| `alp doctor [--quiet]` | registry, runtimes, memory, execution state, stale legacy, build drift |
| `alp update` | resolve + checkout tag GitHub Release mới nhất, rebuild, giữ memory/runtime/backend preferences |
| `alp --version` | in phiên bản đang cài (đọc `package.json`) |
| `alp uninstall [--purge-memory] [--force]` | gỡ CLI/runtime state; backup memory mặc định |
| `scripts/bootstrap.cjs [--no-path]` | clean install/build/validate/doctor/CLI link |

Doctor exit `0` khi healthy, `1` khi có finding cần xử lý, `2` khi doctor tự lỗi. Mỗi finding
có remediation cụ thể. Cutover đã hoàn tất, nên `STALE-LEGACY` chỉ xuất hiện khi máy còn sót
artifact của bản ALP cũ (`identity/`, `CHARTER.md`, compiled ACL); doctor sẽ chỉ cách dọn.

### Cắt bản release (cho maintainer)

1. Viết mục `[Chưa phát hành]` trong `CHANGELOG.md` cho bản này.
2. `node scripts/cut-release.cjs <patch|minor|major|X.Y.Z>` — bump `package.json.version`,
   đóng mục CHANGELOG theo ngày, tạo commit `chore(release): vX.Y.Z` và tag. Thêm
   `--dry-run` để xem trước. Script cố ý dừng trước push.
3. `git push origin main --tags`.
4. `gh release create vX.Y.Z --generate-notes` — publish GitHub Release từ máy, biết kết quả
   ngay. Repo cố ý không dùng GitHub Actions cho việc này; lý do ghi trong
   `.claude/skills/release/SKILL.md`.
5. Từ đây, `alp update` và installer trên máy khác sẽ resolve được `vX.Y.Z` làm bản mới nhất.

## Cấu trúc

```text
src/
  agents/       immutable AgentDefinition registry
  policy/       delegation, tool, memory và workspace authorization
  memory/       storage-neutral service + Markdown/remote adapters
  execution/    identity capsules, policy snapshots, execution state
  workflow/     state machine và output validation/repair
  runtime/      Claude/Codex launch-spec adapters
  backend/      runtime-neutral execution lifecycle
  delegation/   request normalization, backend pinning, result routing
  cli/          alp commands và runtime selection
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

`npm test` chạy unit, contract, integration và E2E. Bốn suite E2E (`test/e2e/`) dựng fake
runtime binaries cho `claude`/`codex` để kiểm launch contract, delegation, memory isolation
và runtime selection mà không gọi model trả phí. Chín script `scripts/test-*.cjs` giữ phần
cross-platform: CLI link, Codex role, delegation backends, execution hooks, runtime/Windows
installer, update và uninstall — trong đó uninstall có process-level fixture để chứng minh
CLI vẫn hoàn tất sau khi xoá installation đang chứa code của chính nó.

## Guardrails

- Không gọi raw Herdr/Paseo hoặc in-process subagent để bypass ALP.
- Unknown tool/path/role/request luôn bị từ chối.
- Private memory chỉ role sở hữu được đọc.
- Không sửa agent definition/policy source từ một delegated execution.
- Không commit, push, deploy hay purge memory nếu principal chưa yêu cầu rõ.
