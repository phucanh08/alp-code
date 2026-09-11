# ALP Delegation API

> Interface chuẩn để Phở giao việc cho role khác. Agent nên nạp `skills/delegation/`;
> backend chỉ chạy execution đã được ALP chuẩn bị.

Invariant của hệ:

> **ALP quyết định ai được giao việc gì cho ai. Backend quyết định execution chạy như thế nào.**

Từ 2026-09-11 câu đó có một nửa thứ hai, và nửa này mới là thứ cưỡng chế được:

> **Execution graph là logical authority.** Ai là cha, cây sâu bao nhiêu, còn bao nhiêu lượt
> giao việc, hạn chót là lúc nào — chỉ cây trả lời. Backend store chỉ là process authority
> (pid, log, result file). Legacy delegation store chỉ được hỏi khi cây **không có** node
> nào cho execution đó.

## Kiến trúc

```text
Principal
   │
   ▼
 Main / business code
   │
   ▼
DelegationService
   ├── ExecutionGraphService  cây thật: parent, trần, allowance, deadline, cancellation
   ├── AgentRegistry          compiled TypeScript definitions
   ├── DelegationPolicy       exact delegates_to + reports_to
   ├── ContextBuilder         immutable capsule + scoped memory + task + workspace policy
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
- task ownership và ALP `requestId`/`executionId`/`parentExecutionId`;
- cấu trúc cây: depth, số con, số con chạy đồng thời, lifetime allowance, deadline tuyệt đối
  và cascade cancellation.

Backend chỉ sở hữu process/session/workspace execution, runtime status, output, cancel và
cleanup. PID và log file chỉ tồn tại trong state nội bộ của backend.

Ba nơi lưu, ba quyền khác nhau — đọc theo đúng thứ tự này khi debug:

| Nơi | Sở hữu | Khi lệch |
|---|---|---|
| `~/.alp/execution-graphs/<graph-id>.json` | quan hệ cha–con, trần, allowance, deadline, lý do huỷ | cây thắng |
| `<state_dir>/local.json` | pid, log file, result file, exit code | backend thắng về *process* |
| `<state_dir>/code-native-executions.json` | record legacy trước P0 | chỉ đọc khi cây không có node |

Reconciliation là thứ nối hai nơi đầu: trước mỗi lần giao việc, cây hỏi backend xem từng node
còn `active` có process thật không, và đóng những node mà process đã biến mất. Không có bước
này thì một lần reboot để lại cây đầy node `running` ma, và mọi lần giao việc sau đó bị trần
đồng thời từ chối.

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
  → authenticateParent(binding)        ← cha là node nào, đọc từ cây sau capability check
  → ExecutionService.authorize         ← DENY-FIRST: target ∈ parent.delegatesTo?
  → reconcileGraph(graphId)            ← đóng node mà process đã chết, trước khi tính trần
  → reserveChild                       ← giữ chỗ: depth, số con, đồng thời, allowance, deadline
  → ExecutionService.materialize       ← policy.json + state.json + capsule
  → adapter.prepare → backend.healthCheck
  → startReservedChild(backend.spawn)  ← spawn chạy DƯỚI lease của cây
```

Mỗi bước đứng trước bước sau vì một lý do, và thứ tự đó là nội dung thật của P0:

- **Xác thực cha trước khi biết cha là ai.** Danh tính không đến từ `--parent-role`, từ
  `ALP_ROLE` hay từ một field trong request — cả ba đều là thứ người gọi tự viết. Nó đến từ
  một binding gồm bốn biến env, tất-cả-hoặc-không, mà process cha nhận lúc nó được spawn:
  `ALP_EXECUTION_GRAPH_ID`, `ALP_DELEGATION_EXECUTION_ID`, `ALP_EXECUTION_CAPABILITY`,
  `ALP_EXECUTION_DEADLINE_AT`. Cây so capability với hash nó giữ; khớp thì actor là
  `node.agentId`, không khớp thì `CAPABILITY_INVALID`.
- **Hỏi policy trước khi chiếm chỗ.** Một request bị từ chối không được giữ một slot đồng
  thời, dù chỉ trong khoảng thời gian nó mất để bị từ chối.
- **Reconcile trước khi tính trần.** Xem bảng ba nơi lưu ở trên.
- **Giữ chỗ trước khi ghi file.** Depth 3 bị từ chối trước khi có thư mục artifact nào.
- **Spawn dưới lease.** Nhả lease trước khi backend có record là mở một cửa sổ mà cây nói
  "đang chạy" còn process thì chưa tồn tại — và trong cửa sổ đó, một lệnh `cancel` không tìm
  thấy gì để giết.

Ví dụ loadout thật: `main → search` và `main → review` được phép; `search → review` bị
`UnauthorizedDelegation` ngay trong core. Khi deny, backend không được health-check hay spawn.

### `delegatesTo` cho phép, `reportsTo` chỉ mô tả

Đúng **một** nguồn quyền: `target ∈ parent.delegatesTo`. `reportsTo` nói kết quả đi ngược lên
đâu và vai này ngồi dưới ai trong sơ đồ tổ chức — nó không cấp và không thu quyền nào. Hai
field trùng nhau trong loadout hiện tại (`main` giao cho tất cả, tất cả report về `main`), và
chính vì trùng nên dễ viết code đọc nhầm field: một `reportsTo` bị sửa sẽ mở một cạnh
delegation mà không ai duyệt.

## Execution graph

Một `graphId` là một cây, và `graphId === rootExecutionId` — cây sinh ra cùng phiên `alp` và
chết cùng nó. Document nằm ở `~/.alp/execution-graphs/<graph-id>.json` (`0600`), có
`by-execution/<exec-id>` để tra ngược từ một node bất kỳ về cây chứa nó.

Node có tám trạng thái, bốn sống và bốn chết:

```text
preparing → queued → running ─┬→ completed
    │          │       │      ├→ failed
    │          │       └──────┼→ cancelled     (cancelling → cancelled)
    └──────────┴──────────────┴→ interrupted   (process biến mất, không ai ghi kết quả)
```

Trần của P0 là **cố định trong code**, không phải config — không có khoá nào trong
`alp.config.yaml` mở được chúng:

| Trần | Giá trị | Mã lỗi khi chạm |
|---|---|---|
| Độ sâu tối đa | `2` (root là 0) | `DEPTH_LIMIT_EXCEEDED` |
| Số con mỗi execution | `4` | `CHILD_LIMIT_EXCEEDED` |
| Con chạy đồng thời mỗi execution | `2` | `CONCURRENCY_LIMIT_EXCEEDED` |
| Execution sống đồng thời cả cây | `6` | `GRAPH_CONCURRENCY_LIMIT_EXCEEDED` |
| Lượt giao việc cả đời cây | `8` | `DELEGATION_LIMIT_EXCEEDED` |
| Wall clock cả cây | 2 giờ | `WALL_CLOCK_EXCEEDED` |
| TTL của một reservation | 2 phút | `RESERVATION_EXPIRED` |

Allowance tính theo *lượt*, không theo node đang sống: một con đã xong vẫn tiêu một lượt. Một
request bị từ chối thì không tiêu lượt nào, và một `requestId` lặp lại cũng vậy — nó nhận lại
đúng node cũ (`reserveChild` trả `existing`) chứ không đẻ con thứ hai. Đó là thứ giữ cho một
lần mất kết nối không biến thành hai process cùng sửa một workspace.

### Deadline không phải `--timeout-ms`

Hai thứ khác nhau, và lẫn chúng là cách bỏ sót một cây đã quá hạn:

| | Deadline của cây | `--timeout-ms` |
|---|---|---|
| Là gì | một timestamp tuyệt đối, chốt **một lần** ở root | thời lượng một lần `wait` chịu đựng |
| Ai nhận | mọi node trong cây, kế thừa **đúng** timestamp đó | riêng lệnh đang gọi |
| Quá hạn thì | cả cây bị huỷ, `terminationReason: "deadline"` | caller bỏ cuộc; execution nền vẫn chạy |

Con không được cấp hạn mới và không được xin gia hạn: `ALP_EXECUTION_DEADLINE_AT` của cháu
bằng đúng của root. Một cây tự gia hạn là một cây không có hạn.

### Cascade cancellation

`cancel` trên một node đóng nhánh đó trước khi gửi bất kỳ tín hiệu nào — nhánh bị khoá không
đẻ thêm con, mọi reservation trong nhánh bị thu hồi, rồi tín hiệu đi từ thế hệ sâu nhất lên.
Node bị hỏi mang `USER_REQUEST · requested by principal`; con cháu mang `PARENT_CANCELLED`
kèm execution ID của node đã chết. Anh em ở nhánh khác không bị đụng tới. Nếu backend từ chối
tín hiệu, node ở lại `cancelling` và lần `reconcile` sau mới đóng nó — không bao giờ có node
tự nhận là `cancelled` trong khi process vẫn sống.

### Secret không thành durable state

Cây chỉ giữ **hash** của capability. Bản thân capability sống trong env của process sở hữu nó
và không có mặt trong graph document, `policy.json`, `state.json`, log, result, hay output của
bất kỳ lệnh CLI nào. Đường duy nhất nó chạm đĩa là supervisor spec của background spawn: file
`0600`, và supervisor `unlink` nó **trước** khi spawn runtime, nên khoảng thời gian nó tồn
tại không bao gồm lúc agent đang chạy.

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

alp delegation tree    exec_...  [--json]
alp delegation status  exec_...
alp delegation wait    exec_...
alp delegation cancel  exec_...
alp delegation cleanup exec_...
alp delegation list
```

`tree` nhận execution ID của **bất kỳ** node nào và luôn vẽ từ root xuống, đánh dấu `←` vào
node được hỏi. Con xếp theo `createdAt`, hoà thì theo execution ID, nên hai lần đọc cùng một
cây cho ra cùng một chuỗi byte. `--json` trả thẳng view cho script; không có `--json` thì CLI
tự định dạng — đây là lệnh lifecycle duy nhất làm vậy.

```text
graph exec_main  ·  revision 7  ·  updated 2026-09-11T02:14:05.000Z
deadline 2026-09-11T04:00:00.000Z
delegation 3/8 used  ·  5 remaining
nodes 4  ·  2 active  ·  1 slot(s) held
limits: depth ≤ 2  ·  4 children/execution  ·  2 concurrent children  ·  6 concurrent executions

main  ·  exec_main  ·  running
├─ search  ·  exec_search  ·  failed  ·  req req_2  ·  CHILD_START_FAILED: runtime refused the task
└─ worker  ·  exec_worker  ·  cancelled  ·  req req_3  ·  USER_REQUEST · requested by principal  ←
   └─ search  ·  exec_grandchild  ·  cancelled  ·  PARENT_CANCELLED · requested by exec_worker
```

Trần được in kể cả khi chưa chạm tới: câu hỏi người vận hành mang tới lệnh này gần như luôn là
"vì sao nó không đẻ thêm con nữa", và câu trả lời là một con số trong khối đó. `slot(s) held`
là reservation đã giữ mà chưa thành node — một con số, không phải danh sách, vì reservation ID
không phải thứ để in ra.

`tree` không in capability hash, fingerprint của request, hay reservation internals. Nó in
`requestId` để nối lại với lệnh đã gọi, và không hơn.

### Breaking change: delegate phải có cha

`alp delegate` gõ từ terminal trần bị từ chối với `PARENT_EXECUTION_REQUIRED`:

```text
delegation requires an authenticated parent execution; run it from inside an ALP session
```

Trước P0, lệnh này suy ra vai cha từ env và chạy được ở bất cứ đâu. Nó không còn chạy được,
vì một cây suy ra từ env là một cây bất kỳ ai cũng dựng được — và một execution không có cha
là một execution không trần, không hạn, không ai huỷ được.

**Cách làm thay thế:** mở phiên bình thường và nhờ `main` giao việc.

```bash
cd ~/code/my-app
alp                       # phiên main: đây là chỗ cây được tạo
# rồi nói với main: "giao cho search: tìm auth entrypoint"
```

Lệnh lifecycle (`tree`, `status`, `wait`, `cancel`, `cleanup`, `list`) **không** cần binding —
chúng tra theo execution ID và chạy được từ terminal trần như trước.

### Legacy fallback

Execution tạo trước P0 không có node nào trong cây. `status`/`wait`/`cancel`/`cleanup` vì vậy
hỏi cây trước, và chỉ rơi về `code-native-executions.json` khi cây trả lời **không có node**.
Ba điều kèm theo:

- cây **hỏng** (`EXECUTION_GRAPH_CORRUPT`, không đọc được, lock quá hạn) *không* rơi về legacy —
  một fallback che lỗi cây là cách một cây hỏng trở thành một cây vô hình;
- không record mới nào được ghi vào legacy store nữa; nó chỉ còn được đọc;
- `tree` không có fallback: một execution legacy trả `EXECUTION_NOT_FOUND` chứ không được vẽ
  thành cây một node giả.

Window gỡ: legacy store còn lại cho tới khi không còn execution tiền-P0 nào cần tra. Dọn bằng
`alp delegation cleanup <execution-id>` cho từng cái, hoặc xoá thẳng file khi đã chắc. Không có
migration tự động, và P0 không xoá gì của bản cũ — rollback về bản trước vẫn đọc được đủ
record.

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

`cleanup` chỉ dọn thứ của backend: temporary file, log, result, record process. Node trong cây
và kết quả lịch sử **ở lại**, nên `alp delegation tree` sau `cleanup` vẫn kể được cây đã chạy
những gì. Nó từ chối một execution còn `queued`/`running` (`INVALID_REQUEST`): dọn một
execution đang sống là cắt đúng sợi dây duy nhất còn giết được nó. Một backend đã quên
execution (`local.json` bị dọn, máy khởi động lại) không bị coi là lỗi — lệnh đã đạt được điều
nó hứa.

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

Cây trả thêm một lớp mã riêng, và chúng đều fail đóng:

| Mã | Nghĩa |
|---|---|
| `PARENT_EXECUTION_REQUIRED` | không có binding: lệnh chạy ngoài một phiên ALP |
| `CAPABILITY_INVALID` | binding có nhưng capability không khớp hash của node |
| `PARENT_NOT_ACTIVE` | cha đã terminal — một node đã chết không giao việc được |
| `DEPTH_LIMIT_EXCEEDED` · `CHILD_LIMIT_EXCEEDED` · `CONCURRENCY_LIMIT_EXCEEDED` · `GRAPH_CONCURRENCY_LIMIT_EXCEEDED` · `DELEGATION_LIMIT_EXCEEDED` | chạm trần ở bảng trên |
| `WALL_CLOCK_EXCEEDED` | cây đã quá hạn tuyệt đối |
| `RESERVATION_NOT_FOUND` · `RESERVATION_EXPIRED` | chỗ đã giữ bị thu hồi (huỷ) hoặc hết TTL |
| `REQUEST_IN_PROGRESS` · `REQUEST_ID_CONFLICT` | cùng `requestId` đang được xử lý, hoặc tái dùng cho request khác |
| `EXECUTION_NODE_NOT_FOUND` · `EXECUTION_GRAPH_NOT_FOUND` | không node/cây nào cho ID đó |
| `EXECUTION_GRAPH_CORRUPT` | document không đọc được — **không** fallback sang legacy |
| `INVALID_NODE_TRANSITION` | một chuyển trạng thái mà `ALLOWED_TRANSITIONS` không cho |
| `EXECUTION_GRAPH_LOCK_TIMEOUT` · `EXECUTION_GRAPH_REVISION_CONFLICT` | không lấy được lease, hoặc phát hiện lost update lúc ghi |

Một node chết không đẹp còn mang mã của riêng nó — thứ `tree` in ra sau execution ID:
`ROOT_START_FAILED` và `CHILD_START_FAILED` (backend từ chối spawn sau khi chỗ đã được giữ),
`EXECUTION_NEVER_STARTED` (`queued` quá lâu mà backend chưa từng biết tới nó — caller đã chết
giữa chừng) và `EXECUTION_INTERRUPTED` (có process, rồi không còn, không ai ghi kết cục).

## Ngoài phạm vi P0

Ba thứ hay bị đọc nhầm là đã có:

- **Token budget và tool-call budget.** Không được cưỡng chế. Trần của P0 đếm *execution* —
  depth, số con, đồng thời, lượt giao việc, wall clock — chứ không đếm token hay lượt gọi
  tool. Một cây trong trần vẫn tiêu bao nhiêu token tuỳ nó.
- **Recursion trong loadout thật.** Cây *cho phép* sâu tới 2, nhưng không vai built-in nào
  dùng tới: `worker.delegatesTo` vẫn `[]`, và mọi specialist cũng vậy. Chỉ `main` giao việc.
  Nested flow `main → worker → search` chỉ tồn tại trong registry của test.
- **Trần cấu hình được.** `alp.config.yaml` không có khoá nào mở trần. Đổi trần là đổi code.

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
