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
   └── LocalProcessBackend ── child process + detached supervisor
```

`createDefaultDelegationComposition` (`src/cli/commands/delegate.ts`) là composition root
duy nhất dựng service. `ExecutionBackend` vẫn là interface — đó là seam để test thay bằng
fake — nhưng chỉ có một implementation, và `DelegationService` nhận thẳng nó chứ không qua
registry hay tên. Không có `--backend`, không có fallback, không có lựa chọn lưu trong
config: thứ đang chạy luôn là thứ duy nhất có thể chạy.

`scripts/lib/delegation/` chỉ còn phần CJS mà composition root thật sự load: `config.cjs`
và `command-runner.cjs`. Mọi thứ khác đã chuyển sang TypeScript trong `src/`.

ALP sở hữu:

- identity, role, `reports_to`, `delegates_to`;
- ACL và delegation authorization;
- memory visibility và context construction;
- task ownership và ALP `requestId`/`executionId`/`parentExecutionId`.

Backend chỉ sở hữu process/session/workspace execution, runtime status, output, cancel và
cleanup. PID và log file chỉ tồn tại trong state nội bộ của backend.

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

## Cấu hình

`alp init` canonicalize và đăng ký project vào `~/.alp/projects.json`. Nó **không** cài
runtime — cài Claude Code hoặc Codex là việc của principal.

`alp.config.yaml` chỉ còn đúng một thứ để khai:

```yaml
delegation:
  state_dir: ""
```

Để rỗng thì mặc định là `~/.alp/delegation/<hash repo root>`.

Environment override:

| Biến | Ý nghĩa |
|---|---|
| `ALP_DELEGATION_STATE_DIR` | state/lock lifecycle; mặc định `~/.alp/delegation/<repo-key>` |
| `ALP_CONFIG` | đường dẫn `alp.config.yaml` khác |
| `ALP_REPO_ROOT` | repo root; quyết định state dir mặc định, hooks và skills |

Main chạy trong sandbox cần ghi generic execution state. Execution policy snapshot vì vậy
chỉ mở state/workspace đã đăng ký cho agent có `delegatesTo`. Specialist không nhận các
quyền này; deny rule sinh cho Claude/Codex vẫn chặn raw `herdr`/`paseo`, nên đường được
phép vẫn chỉ là Delegation API sau policy.

## LocalProcessBackend

Backend duy nhất: spawn runtime CLI làm child process, không daemon nào ở giữa.

| ALP | Local nội bộ |
|---|---|
| execution | child process |
| background spawn | detached supervisor (`src/backend/local-supervisor.ts`) sống lâu hơn `alp` |
| state | `<state_dir>/local.json`, có lock, đọc được từ CLI process khác |
| status/wait/output | result file của supervisor, hoặc exit code + signal của child |
| transcript | `<state_dir>/logs/<execution-id>.log`, cắt 200 dòng cuối vào result |
| cancel | `kill(SIGTERM)` |
| cleanup | xoá `launchSpec.temporaryFiles`, log và result |

Đây là backend duy nhất trao cho runtime settings file của chính vai đó, nên
`permissions.deny` và `sandbox.filesystem.denyWrite` thật sự tới được agent — đo ngày
2026-09-03: một `search` delegated đọc private memory của vai khác bị từ chối, và mọi
đường ghi bị chặn ở ba lớp độc lập. Đó là lý do backend thứ hai bị gỡ thay vì giữ song song:
một backend tự spawn runtime qua daemon riêng không tái hiện được điều này, vì permission
request của nó không mang path.

Execution nền không chết theo `alp`: một `wait` quá hạn chỉ là caller bỏ cuộc, supervisor
vẫn giữ agent và vẫn ghi lại nó kết thúc thế nào. Foreground thì ngược lại — timeout dừng
child, vì không còn ai ghi hộ.

## Context, identity và sandbox

`ContextBuilder` gọi cùng boot-context builder của ALP cho target role. Context truyền sang
backend gồm target identity, task và phần memory mà loadout cho phép. Runtime chỉ nhận bundle
đã chuẩn bị; session của runtime không phải ALP identity và không là source of truth của
memory.

Role phụ luôn `read-only` theo ALP guard/policy. `main` chỉ được `workspace-write` tại
alp-code hoặc workspace đã có trong `workspaces.write`; cwd lạ vẫn read-only.

## Error và failure behavior

Core chỉ trả các lỗi trung lập runtime:

`UnauthorizedDelegation`, `UnknownRole`, `BackendUnavailable`, `SpawnFailed`,
`ExecutionFailed`, `Timeout`, `CancelFailed`, `InvalidConfiguration`.

Backend wrap lỗi spawn/process tương ứng. Không có fallback: một spawn hỏng nửa chừng được
ghi là `failed` chứ không bị thử lại ở nơi khác, vì retry sau spawn có thể tạo execution
trùng — và vì không còn nơi nào khác để retry sang.

## Doctor, logging và debugging

```bash
alp delegation list
alp doctor
```

Doctor báo `ORPHAN-EXECUTION` cho execution state còn sót lại, kèm lệnh dọn cụ thể.
`LocalProcessBackend.orphanExecutions()` là thứ trả lời câu hỏi đó: execution còn ghi
`running` nhưng process đã biến mất mà không để lại result file.

Log lifecycle có `request_id`, `execution_id`, `parent_role`, `target_role`, `backend`;
transcript của từng execution nằm ở `<state_dir>/logs/`. PID không trở thành domain
identifier.

## Bỏ Herdr và Paseo

Cả hai backend ngoài đã bị gỡ khỏi repo — Herdr trước đó, Paseo ngày 2026-09-03. Nếu bạn
còn checkout cũ:

1. Bỏ `delegation.backend`, `delegation.fallback_backend` và cả khối `backends:` trong
   `alp.config.yaml`; chỉ `state_dir` còn được đọc.
2. Bỏ `ALP_DELEGATION_BACKEND` / `ALP_DELEGATION_FALLBACK` khỏi shell profile, và bỏ
   `--backend` khỏi mọi script gọi `alp delegate` — cờ đó bị từ chối chứ không bị lờ đi.
3. Execution cũ do backend ngoài sở hữu không còn resolve được (`EXECUTION_NOT_FOUND`);
   dọn bằng tay ở `state_dir`.

Regex chặn raw `herdr`/`paseo` trong `src/policy/invariants.ts` và deny rule sinh cho
Claude/Codex vẫn giữ nguyên làm defense-in-depth: gỡ backend không có nghĩa là cho phép
agent tự gọi binary của nó.
