# ALP Delegation API

> Interface chuẩn để Phở giao việc cho role khác. Agent nên nạp `skills/delegation/`;
> backend chỉ chạy execution đã được ALP chuẩn bị.

Invariant của hệ:

> **ALP quyết định ai được giao việc gì cho ai. Backend quyết định execution chạy như thế nào.**

## Kiến trúc

```text
Principal
   │
   ▼
 Main / business code
   │
   ▼
DelegationService
   ├── AgentRegistry     compiled TypeScript definitions
   ├── DelegationPolicy exact delegates_to + reports_to
   ├── ContextBuilder    immutable capsule + scoped memory + task + workspace policy
   └── BackendRegistry
          ├── LocalProcessBackend ── child process
          └── PaseoBackend ── Paseo public CLI/daemon
```

`createDefaultDelegationComposition` (`src/cli/commands/delegate.ts`) là composition root
duy nhất register implementation. Thêm backend mới bằng cách implement `ExecutionBackend`
rồi register ở đó; không sửa policy, role, memory hay context core.

`scripts/lib/delegation/` chỉ còn phần CJS mà composition root thật sự load: `config.cjs`,
`core/{errors,types,execution-store}.cjs` và `backends/{command-runner,paseo}`. Mọi thứ
khác đã chuyển sang TypeScript trong `src/`.

ALP sở hữu:

- identity, role, `reports_to`, `delegates_to`;
- ACL và delegation authorization;
- memory visibility và context construction;
- task ownership và ALP `requestId`/`executionId`/`parentExecutionId`.

Backend chỉ sở hữu process/session/workspace execution, runtime status, output, cancel và
cleanup. Paseo agent ID chỉ tồn tại trong state/log nội bộ adapter.

## Contract trung lập runtime

```text
DelegationRequest
  requestId · parentRole · parentExecutionId? · targetRole · task
  workspace? · context? · metadata? · executionOptions?

DelegationResult
  executionId · status · output? · artifacts? · error? · metadata?

DelegationBackend
  name
  healthCheck() · spawn() · status() · wait() · cancel() · cleanup()
```

`executionOptions` hiện có `background`, `interactive`, `timeoutMs`, `reuseSession` và
provider runtime hint. `context` đầu vào được `ContextBuilder` nhập vào prepared prompt;
raw field đó bị bỏ trước `BackendExecutionRequest`. `metadata` không được chứa runtime ID.

`DelegationResult.status` chỉ nhận `queued`, `running`, `completed`, `failed`, `cancelled`.
Backend-specific state phải được adapter map về năm giá trị này.

## Luồng policy trước runtime

```text
delegate(request)
  → resolve parent + target role
  → assert target ∈ parent.delegates_to
  → assert target.reports_to = parent
  → build target identity + allowed memory/context
  → resolve configured backend
  → backend.spawn(prepared execution)
  → track ALP executionId
```

Ví dụ loadout thật: `main → search` và `main → review` được phép; `search → review` bị
`UnauthorizedDelegation` ngay trong core. Khi deny, backend không được health-check hay spawn.

Role thường không được gọi raw `herdr`, `paseo`, `create_agent` hoặc `spawn_agent`.
`src/policy/invariants.ts` kiểm exact target ở facade; generated Claude settings deny hai runtime
binary cho cả `main` (`Bash(herdr:*)`, `Bash(paseo:*)`), Codex deny bằng `[[rules]] allow = false`.
Đường chuẩn duy nhất là API bên dưới.

Principal có thể giao việc hoặc tương tác trực tiếp với role. `reports_to` chỉ định tuyến
lifecycle/kết quả khi execution được tạo qua delegation; nó không phải lệnh cấm direct chat.
Direct communication không thay đổi `delegates_to`, memory, tool hay workspace ACL.

## CLI

```bash
alp delegate search --project /path/to/app --background -- "Tìm auth flow"
alp delegate review --project /path/to/app -- "Review patch hiện tại"
alp delegate oracle -- "Phản biện architecture này"

alp delegation status  exec_...
alp delegation wait    exec_...
alp delegation cancel  exec_...
alp delegation cleanup exec_...
alp delegation list
alp delegation health
```

Nếu bỏ `--project`, CLI dùng cwd nơi principal/agent gọi `alp`. `alp.cjs` phải preserve cwd
khi chuyển sang `delegate.cjs`; Core canonicalize path, đưa nó vào prepared prompt và lưu
trong execution state/log. Mỗi delegated execution chỉ được đọc source workspace đó; một
workspace khác dù còn nằm trong target `workspaces.read` vẫn bị hook từ chối trong lượt này.

Lifecycle công khai là:

```text
queued → running ─┬→ completed
                  ├→ failed
                  └→ cancelled
```

`run-role` vẫn là compatibility facade và gọi cùng `DelegationService`:

```bash
scripts/run-role.sh search --project /path/to/app --pane -- "Tìm auth flow"
scripts/run-role.sh read-thread --exec -- "Tìm decision về ACL"
```

Trong compatibility facade, `--pane` chỉ còn là alias cho background execution và `--exec`
là foreground/headless. Output mới dùng `EXECUTION`, `STATUS`, `BACKEND`; consumer không cần
biết runtime ID. `--release <id>` được giữ làm alias cũ cho cleanup; nên chuyển sang
`alp delegation cleanup <execution-id>`.

## Cấu hình backend

`alp init` ghi backend đã chọn vào `~/.alp/projects.json`. Nó **không** cài runtime — cài
là việc của principal:

```bash
alp init /path/to/project --backend local   # child process, không cần cài gì
alp init /path/to/project --backend paseo   # cần `npm install -g @getpaseo/cli` sẵn
```

Bỏ `--backend` thì lựa chọn đã đăng ký trước đó được giữ nguyên; project chưa từng chọn
thì rơi về thứ tự ưu tiên bên dưới. Kiểm tra runtime đã sẵn sàng chưa bằng
`alp delegation health <backend>`.

`alp.config.yaml`:

```yaml
delegation:
  backend: paseo
  fallback_backend: ""
  state_dir: ""

  backends:
    paseo:
      enabled: true
      cli: paseo
      host: ""
      runtime_tools_disabled: true
```

Không có config thì default là `paseo`. `local` luôn được đăng ký và không cần khai trong
`backends:`. Đổi backend không làm thay đổi identity, memory, role hay policy.

`fallback_backend` để rỗng là chủ ý: fallback chuyển execution sang backend khác một cách
im lặng, khó chẩn đoán hơn là fail rõ ràng.

Chuyển tương tác, dùng chung giữa Claude Code và Codex:

```bash
alp delegation switch                 # xem effective backend + nguồn lựa chọn
alp delegation switch paseo           # các request tiếp theo dùng Paseo
alp delegation switch local            # các request tiếp theo dùng local
alp delegation switch default          # bỏ lựa chọn, quay về env/config
```

Selection từ `alp init` hoặc switch lưu trong generic ALP state, không sửa source config.
Thứ tự ưu tiên là request `--backend` → persisted init/switch selection → environment →
config → Paseo.
Execution đã spawn luôn giữ backend trong execution record và không bị chuyển giữa chừng.

Environment override:

| Biến | Ý nghĩa |
|---|---|
| `ALP_DELEGATION_BACKEND` | backend mặc định |
| `ALP_DELEGATION_FALLBACK` | fallback trước spawn khi backend chính unhealthy |
| `ALP_DELEGATION_STATE_DIR` | state/lock lifecycle; mặc định `~/.alp/delegation/<repo-key>` |
| `PASEO_CLI` | binary Paseo |
| `PASEO_HOST` | daemon URL; không hard-code trong source |
| `PASEO_HOME` | config home cho local safety check |
| `ALP_PASEO_RUNTIME_TOOLS_DISABLED` | attestation cho remote daemon |

`--backend local|paseo` chỉ là override cho đúng một request. Registry vẫn chịu
trách nhiệm resolve tên; core không có chuỗi `if paseo / else local`.

Main chạy trong sandbox cần ghi generic execution state và kết nối backend daemon local.
Execution policy snapshot vì vậy chỉ mở state/workspace đã đăng ký cho agent có
`delegatesTo`; runtime adapter truyền đúng execution ID để Paseo localhost hoạt động.
Specialist không nhận các quyền runtime này; deny rule sinh cho Claude/Codex vẫn chặn raw
`herdr`/`paseo`, nên đường được phép vẫn chỉ là Delegation API sau policy.

## LocalProcessBackend

Backend mặc định khi không có daemon nào: spawn runtime CLI làm child process của chính
tiến trình `alp`.

| ALP | Local nội bộ |
|---|---|
| execution | child process |
| background spawn | không hỗ trợ — execution gắn với vòng đời tiến trình cha |
| status/wait/output | exit code + signal của child |
| cancel | `kill(SIGTERM)` |
| cleanup | xoá `launchSpec.temporaryFiles` |

Không cài gì, không health check nào có thể fail. Đánh đổi: không có execution nào sống sót
qua khi `alp` thoát, nên nó không thay được Paseo cho việc chạy nền.

## PaseoBackend

Adapter dùng public Paseo CLI và daemon API mà CLI cung cấp; không fork hay sửa source Paseo:

| ALP | Paseo nội bộ |
|---|---|
| execution | agent |
| parent execution | parent agent qua backend-only `PASEO_AGENT_ID` mapping |
| workspace path | `run --cwd` |
| spawn | `run --background --json` |
| status | `inspect --json` |
| wait/result | `wait --json` + bounded `logs` |
| cancel | `stop --json` |
| cleanup | `agent archive --force --json` |

Adapter inject capsule ALP đã chuẩn bị và `ALP_DELEGATION_EXECUTION_ID`; Paseo không tự đọc
memory hay agent definitions để quyết quyền. Paseo agent ID được lưu trong backend state và chỉ xuất hiện
trong observability field `backend_execution_id`, không nằm trong `DelegationResult`.

Paseo 0.5.x không expose Codex `read-only` như creation mode (`auto`, `auto-review`,
`full-access` là các mode public; `auto-review` vẫn workspace-write). Adapter dùng `auto`
để tương thích và inject `ALP_READONLY_DIRS` + `ALP_DELEGATION_WORKSPACE`; ALP project hook
giữ role phụ read-only và khóa đúng workspace. Claude read-only tiếp tục map sang `plan`.

Paseo có thể inject raw MCP delegation tools vào agent. Local adapter fail trước spawn nếu
`~/.paseo/config.json` có `daemon.mcp.injectIntoAgents=true`; hãy đặt false và reload Paseo.
Với daemon remote, `runtime_tools_disabled: true` là attestation bắt buộc của operator.

## Context, identity và sandbox

`ContextBuilder` gọi cùng boot-context builder của ALP cho target role. Context truyền sang
backend gồm target identity, task và phần memory mà loadout cho phép. Runtime chỉ nhận bundle
đã chuẩn bị; Paseo agent không phải ALP identity và không là source of truth của
memory.

Role phụ luôn `read-only` theo ALP guard/policy. `main` chỉ được `workspace-write` tại
alp-code hoặc workspace đã có trong `workspaces.write`; cwd lạ vẫn read-only.

## Error và failure behavior

Core chỉ trả các lỗi trung lập runtime:

`UnauthorizedDelegation`, `UnknownRole`, `BackendUnavailable`, `SpawnFailed`,
`ExecutionFailed`, `Timeout`, `CancelFailed`, `InvalidConfiguration`.

Adapter wrap lỗi CLI/socket tương ứng. Không tự fallback sau khi spawn đã được thử vì có thể
tạo execution trùng. `fallback_backend` chỉ được xét trước spawn, sau health check; mặc định
rỗng để failure rõ ràng. Execution đã spawn luôn được route lại đúng backend bằng state của
ALP, kể cả sau khi config mặc định đổi.

## Doctor, logging và debugging

```bash
alp delegation health
alp delegation health paseo
alp delegation list
alp doctor
```

Doctor dùng terminology generic: `DELEGATION-BACKEND`, `BACKEND-HEALTH`,
`ACTIVE-EXECUTIONS`, `ORPHAN-EXECUTIONS`, `ORPHAN-EXECUTION`.

Log lifecycle có `request_id`, `execution_id`, `parent_role`, `target_role`, `backend`; adapter
log thêm `backend_execution_id` để debug. Backend ID không trở thành domain identifier.

Debug Paseo: kiểm `paseo daemon status --json`, `PASEO_HOST` và raw-tool policy.

## Bỏ Herdr

Herdr backend đã bị gỡ khỏi repo. Nếu bạn còn checkout cũ trỏ `backend: herdr`:

1. Đổi `delegation.backend` sang `paseo` (hoặc `local`), hoặc chạy
   `alp delegation switch paseo`.
2. Chạy `alp delegation health paseo` để xác nhận daemon reachable.
3. Execution cũ do Herdr sở hữu không còn resolve được; dọn bằng tay ở `state_dir`.

Regex chặn raw `herdr` trong `src/policy/invariants.ts` và deny rule sinh cho Claude/Codex
vẫn giữ nguyên làm defense-in-depth.
