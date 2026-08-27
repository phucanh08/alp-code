# alp-code

ALP là launcher code-native cho một nhóm agent dùng chung policy, workflow và memory. Mỗi
execution nhận một `AgentDefinition` bất biến, policy snapshot và identity capsule trước khi
được chuyển thành lệnh Claude Code hoặc Codex. Runtime chỉ chạy launch spec; Herdr/Paseo chỉ
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

Installer cần Git và Node.js >= 18. Nó clone/pull source rồi gọi `scripts/bootstrap.cjs` để:

1. dựng phần memory/state còn thiếu mà không ghi đè dữ liệu;
2. chạy `npm ci --include=dev` và build TypeScript;
3. validate `AgentRegistry` và hai runtime adapter;
4. chạy doctor;
5. cài lệnh `alp` vào PATH.

| Tuỳ chọn | bash | PowerShell |
|---|---|---|
| Đổi vị trí cài | `bash -s -- --home ~/dev/alp` hoặc `ALP_HOME=…` | `$env:ALP_HOME = "D:\alp-code"` |
| Không sửa PATH | `bash -s -- --no-path` hoặc `ALP_NO_PATH=1` | `$env:ALP_NO_PATH = "1"` |
| Nhánh khác | `bash -s -- --branch dev` hoặc `ALP_BRANCH=…` | `$env:ALP_BRANCH = "dev"` |

Chạy lại installer hoặc `alp update` sẽ fast-forward source rồi rebuild. Update backup và
khôi phục nguyên trạng `memory/`, runtime preference và backend preference. Source edit,
staged change hoặc pull không fast-forward làm update dừng; ALP không tự merge source.

## Bắt đầu một project

```bash
cd ~/code/my-app
alp init --backend herdr        # hoặc paseo
alp                             # chọn runtime tương tác
alp --runtime claude
alp --runtime codex
```

`alp init` chỉ canonicalize và đăng ký project trong `~/.alp/projects.json`, kèm backend
nếu được chọn. Nó không tạo `.claude/`, `.codex/`, skill link hay runtime identity config
trong project, nên `git status --porcelain` không đổi.

Project đã đăng ký cho phiên `main` quyền `workspace-write`; cwd chưa đăng ký là
`read-only`. `alp deinit` gỡ registration và dọn artifact cũ do các bản ALP trước tạo ra,
nhưng không xoá memory của project.

Runtime preference độc lập với backend preference:

```bash
alp runtime show
alp runtime set codex
alp delegation switch herdr
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
  -> ExecutionBackend (local/Herdr/Paseo lifecycle)
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
| `alp update` | pull an toàn, rebuild, giữ memory/runtime/backend preferences |
| `alp uninstall [--purge-memory] [--force]` | gỡ CLI/runtime state; backup memory mặc định |
| `scripts/bootstrap.cjs [--no-path]` | clean install/build/validate/doctor/CLI link |

Doctor exit `0` khi healthy, `1` khi có finding cần xử lý, `2` khi doctor tự lỗi. Mỗi finding
có remediation cụ thể. Cutover đã hoàn tất, nên `STALE-LEGACY` chỉ xuất hiện khi máy còn sót
artifact của bản ALP cũ (`identity/`, `CHARTER.md`, compiled ACL); doctor sẽ chỉ cách dọn.

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
