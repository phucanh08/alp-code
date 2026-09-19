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

## `alp` trong sandbox: relay qua process root

Vai đang chạy *trong* sandbox gõ `alp delegate worker …` — nhưng process `alp` đó không thể
là process thi hành delegation: nó không ghi được `~/.alp` (Codex read-only, Claude
`denyWrite`), và một worker nó spawn sẽ thừa kế sandbox của nó. Đo đầy đủ ngày 2026-09-18
trên cả hai runtime, cùng lý do loại từng phương án khác (unix socket bị `EPERM` ở cả hai,
`excludedCommands` rò rỉ `&&`/`;`, Codex không escalate được dưới `approval_policy=never`):
`plans/260918-0700-execution-relay/research/alp-inside-sandbox.md`.

Quyết định: **process root `alp` là process duy nhất thi hành lệnh ALP thay cho một
execution.** `alp` trong sandbox chỉ là *client*.

```text
<execution>/relay/server.json            { v:1, pid, executionId, registeredAt }   ← root ghi lúc đăng ký
<execution>/relay/<id>.request.json      { v:1, id, argv, cwd, requestedAt }       ← client ghi (tmp + rename)
<execution>/relay/<id>.response.json     { v:1, id, exitCode, stdout, stderr, finishedAt }
```

- **Client** (`src/cli/relay-client.ts`, gate trong `dispatchEntry`): thấy `ALP_RELAY_DIR`
  là đi relay — không `ensureState`, không load full CLI. Chỉ `--version`, `hook` và
  `__internal` còn chạy in-process. Poll 50 → 500 ms, mỗi vòng kiểm `kill(pid, 0)` và
  `ALP_EXECUTION_DEADLINE_AT`; thiếu `server.json`, pid chết hay hết hạn ⇒ lỗi rõ, không im
  lặng.
- **Server** (`src/execution/relay-server.ts`): root `register({ executionId, directory,
  env })` khi phóng, `close()` khi settle. Với mỗi request nó spawn `layout.stableCommand
  <argv>` với env = env của root ⊕ launch env của execution, **bỏ** `ALP_RELAY_DIR` — cùng
  code path như gõ từ terminal, nên `alp delegate` không có semantics thứ hai.
- **Allowlist server-side, fail-closed**: `delegate`, `delegation *`, `context *`, `help`,
  `--version` — đúng bằng những gì session context bảo vai gõ. Mọi thứ khác exit 2.
- **Binding là của thư mục, không của request.** Request là input untrusted từ model; env
  mà server ghép vào là env ALP gắn cho execution đó lúc đăng ký. Con A không mượn được
  binding của root hay của con B.

Ai đăng ký: `runThreadRoot` cho phiên root; `DelegationService` cho con **foreground** —
đăng ký *trước* khi spawn (không có cửa sổ con chạy mà chưa ai phục vụ), đóng khi `wait`
terminal, spawn hỏng hay `cancel`. Con `--background` (GitHub #24) do **supervisor detached**
của backend local phục vụ: process gọi `alp delegate --background` thoát ngay, nên
`server.json` phải mang pid của thứ sống bằng đời con — chính supervisor đang giữ runtime.
`LocalProcessBackend` đưa `relay: { directory, stableCommand }` vào spec của supervisor
(`relayCommand` là `layout.stableCommand`); supervisor đăng ký trước khi spawn, đóng khi
runtime kết thúc, và cùng `RelayServer` + allowlist với root. Không có `relayCommand`
(backend dựng tay) thì con background không có relay như trước.

Sandbox mở đúng một chỗ cho kênh này: Claude `sandbox.filesystem.allowWrite:
[<execution>/relay]`; Codex một entry `"write"` cho `<execution>/relay` trong profile.
`relay/` là `0700`, nằm ngoài workspace, sống cùng execution dir.

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

### `--workspace` ngoài grant: hỏi hay từ chối

`ExecutionService.authorize` không chỉ trả allow/deny — `PolicyEngine.decide()` còn có một
đáp án thứ ba, `require_approval`, và trong phạm vi hiện tại nó chỉ phát ra cho **một** luật:

| `--workspace` của con nằm ở | Kết quả |
|---|---|
| trong workspace của cha (grant) | allow, không hỏi |
| ngoài grant, **trong** project đã đăng ký (`alp init`) | `require_approval`, scope `session` |
| ngoài project | `WORKSPACE_SCOPE_MISMATCH` — không hỏi |

Grant là workspace của **cha**, đọc từ `policy.json` đã ký của cha — không phải từ request,
vì đó là field người gọi tự điền. Project là project đăng ký trong cùng nhất chứa grant
(`ProjectRegistryStore.projectContaining`); không có thì grant là project của chính nó. "Trong"
là biên đường dẫn: `mono-x` không nằm trong `mono`.

Câu hỏi là một bước *bên trong* `authorize()`, trước khi có ticket. Ai trả lời được là chuyện
của surface, và `alp delegate` **không có surface** — process con không có principal ở bàn phím,
và một lá hỏi được là một lá bị prompt-inject có thể tự chế câu hỏi. Vì thế:

- không có surface ⇒ `APPROVAL_UNAVAILABLE`, deny trước reservation, trước mọi file;
- principal nói "no" ở root ⇒ `APPROVAL_DENIED`, và "no" **không** được ghi lại;
- principal nói "yes" ở root ⇒ `ApprovalRecordV1 { rule, subject, scope, decidedBy, decidedAt }`
  ghi vào `<root>/context/approvals.json` (sống qua dọn `runtime/`), và mọi con dưới root đó
  hỏi cùng câu — cùng `rule`, cùng `subject` — được trả lời mà không hỏi lại.

Bản ghi đi vào `ExecutionPolicy.approvals` của con và vào `policyHash`: một execution được nới
workspace vì có người nói "yes" là một identity khác với một execution không phải hỏi.
`alp thread show` in các approval của từng root.

### `--write-scope`: con chỉ được ghi một phần workspace

`alp delegate worker --write-scope src/parser --write-scope docs -- fix the parser` giao việc
cho một vai `workspace-write` nhưng chỉ cho nó ghi hai cây con đó. Cờ lặp được; đường dẫn
tương đối so với `--workspace` hoặc tuyệt đối; bỏ cờ là cả workspace như trước. Scope đi qua
`PolicyEngine.decide()` **trước** luật `--workspace` ở trên — một scope sai không bao giờ là
thứ đem đi hỏi principal — và qua đúng thứ tự:

| Scope | Kết quả |
|---|---|
| có scope nhưng vai đích `read-only` | `WRITE_SCOPE_ON_READ_ONLY` |
| entry không tồn tại trên đĩa | `WRITE_SCOPE_NOT_FOUND` — không tạo hộ |
| entry ngoài workspace sau khi resolve (`..`, tuyệt đối, **symlink trỏ ra ngoài**) | `WRITE_SCOPE_OUTSIDE_WORKSPACE` |
| entry chạm `~/.alp/executions/` (bằng, chứa, hay nằm trong) — hoặc launch *không* scope mà workspace chứa nó | `WRITE_SCOPE_PROTECTED_ROOT` |
| cha có scope, con xin rộng hơn (entry ngoài scope cha; hoặc con không scope mà workspace không nằm trong scope cha) | `WRITE_SCOPE_EXCEEDS_PARENT` |
| danh sách rỗng, entry trống | `INVALID_REQUEST` ở `DelegationService`, trước khi hỏi policy |

Mỗi entry được resolve qua symlink như workspace (`realpath`), rồi sort + bỏ trùng, và đi vào
`ExecutionPolicy.writeScope` — `null` **tường minh** khi không scope, vì `canonicalize()` bỏ
key `undefined` và một policy không scope không được trùng hash với policy viết trước P2. Nó
nằm trong `policyHash` (hook bridge chép lại qua `readWriteScope`, một `policy.json` bị nới
scope sau khi ký là "invalid or stale"), trong fingerprint của request (cùng task khác scope
là việc khác), và trong `alp delegation status` (`writeScope` trong kết quả, đọc từ snapshot
đã ký chứ không từ request). Scope của cha đọc từ chính `policy.json` của cha và đi cùng grant
(`launch.writeScope`), nên một con không thể xin thứ cha không có.

Runtime nhận scope theo cách nó cưỡng chế được:

- **Codex**: profile trên argv liệt kê `"write"` cho `[<scope...>, <private memory của vai>]`
  — thay workspace chứ không thêm vào; sandbox của Codex tự từ chối phần còn lại
  (`enforced`, đo lại 2026-09-18 trên chính dạng launch dùng). Trước đó scope chỉ nằm trong
  `codex-config.toml` — file Codex **không đọc** — nên cell này từng được đo trên cơ chế chứ
  không trên launch; xem § "Runtime cưỡng chế được gì".
- **Claude (darwin/linux)**: đo trên 2.1.269 (`research/claude-sandbox-precedence.md`)
  `denyWrite` thắng `allowWrite`, nên không "cho phép" được một cây con — ALP liệt kê **những
  gì đứng cạnh scope** trên đường từ workspace xuống tới scope và deny từng thứ, ở cả hai mặt:
  `permissions.deny` `Edit(//path/**)` (Claude áp cùng luật cho Write/NotebookEdit/MultiEdit;
  `Write(...)` bị bỏ qua) và `sandbox.filesystem.denyWrite`. Cái gì tồn tại lúc phóng thì bị
  chặn; một entry tạo *sau đó* cạnh scope thì không — đó là `partial`, không phải `enforced`.
- **Claude (win32)**: chỉ có luật `Edit`, không có sandbox — `declared-only` như trước.

Không cấu hình nào của runtime chứa `~/.alp/executions/` trong danh sách ghi được, và một
scope bị từ chối không để lại node, file hay process nào.

### Assignment có biên: `--exclude-scope`, `--objective`, `--verification`, và chồng lấn

Master plan 2b. `--write-scope` nói con *được* ghi gì; ba cờ này nói phần còn lại của một
assignment — cái con **không** được ghi dù nằm trong scope, việc phải đạt, và cách nghiệm
thu — thành **trường riêng** của `DelegationRequest` (`excludeScope`, `objective`,
`verification`, mỗi cái `null` khi không khai) thay vì trộn vào task text rồi hy vọng con
đọc ra:

```bash
alp delegate worker --write-scope src --exclude-scope src/parser \
  --objective 'Lexer emits one token per literal' \
  --verification 'npx vitest run test/lexer' \
  -- 'Viết lại lexer'
```

`--exclude-scope <path>` (lặp được) là **bù** của scope: mỗi entry phải tồn tại
(`EXCLUDE_SCOPE_NOT_FOUND`), nằm trong một gốc được ghi — scope đã khai, hoặc cả workspace
khi không scope (`EXCLUDE_SCOPE_OUTSIDE_WRITE_SCOPE`), và không được *bằng* gốc đó, vì loại
trọn scope là một scope rỗng (`EXCLUDE_SCOPE_COVERS_WRITE_SCOPE`); vai đích read-only thì
`EXCLUDE_SCOPE_ON_READ_ONLY`. Policy xét scope trước, exclusion sau. Entry resolve, sort, bỏ
trùng như scope và đi vào `ExecutionPolicy.excludeScope` — khác `writeScope`, key này **chỉ
có mặt khi có loại trừ**, để mọi `policy.json` viết trước 2b giữ nguyên hash; hook bridge
chép lại qua `readExcludeScope`, bỏ exclusion sau khi ký là "invalid or stale". Runtime:
Claude deny thêm từng entry (`Edit(//path/**)` + `sandbox.filesystem.denyWrite`) cạnh các
sibling của scope; **Codex chỉ nhận exclusion ở mức lời dặn** — permission profile của Codex
không có "write trừ cây con này", nên cell này là `declared-only` và evidence là chỗ bắt
(xem dưới).

`--objective <text>` và `--verification <text>` là hai câu; câu trống là `INVALID_REQUEST`
(bỏ cờ thay vì để trống). Cả bốn trường vào fingerprint của request — cùng task khác
objective/exclusion là việc khác (`REQUEST_ID_CONFLICT` khi retry cùng `requestId`).

Con nhận assignment bằng một khối đứng **trước** task trong prompt, đường dẫn đã canonical
— đúng cái sandbox chặn:

```text
Objective: Lexer emits one token per literal
Owned paths (you may write): `/ws/src`
Excluded paths (you may not write, another execution owns them): `/ws/src/parser`
Verification (how done is checked): npx vitest run test/lexer

Viết lại lexer
```

Khối chỉ được render khi request có gì ngoài task (objective, verification hay exclusion):
một lần giao việc chỉ có `--write-scope` đọc ra y hệt trước 2b. `taskExcerpt` trên node cây
vẫn là task nguyên văn.

**Hai con đang sống không được cùng sở hữu một path.** Sau khi giữ chỗ trong cây (để retry
cùng request vẫn trả về con cũ), `DelegationService` đọc `policy.json` đã ký của mọi node
`workspace-write` chưa kết thúc trong cùng graph — trừ chính nó và các tổ tiên của nó, vì
con đứng trong scope cha là chuyện bình thường — và từ chối `WRITE_SCOPE_OVERLAP` khi có
**vùng chung**: hai gốc được ghi mà một gốc nằm trong gốc kia (vùng chung là gốc sâu hơn; không
scope là cả workspace), và không bên nào đã *loại trọn* vùng đó. Loại một phần không đủ. Đó
chính là cách hai `worker` cùng đứng trong `src/`: một con `--write-scope src --exclude-scope
src/parser`, con kia `--write-scope src/parser`. Message nêu execution đang sở hữu và ba lối
ra: thu hẹp scope, loại bằng `--exclude-scope`, hay đợi. Node bị từ chối được thả ngay, không
để lại file hay process. Một node đang giữ chỗ mà chưa có `policy.json` (hai `delegate` chạy
đúng cùng lúc) chưa nhìn thấy nhau — cửa sổ vài mili-giây, ghi nhận, chưa đóng.

Evidence dùng cùng định nghĩa (`src/execution/assignment.ts`: `ownsPath`, `sharedRegion`):
`outsideScope` coi một path trong exclusion là ngoài scope, và `ambiguousNodes` không kể một
node đã loại trọn vùng chung là "cũng có thể đã sửa". Với Codex đây là lưới duy nhất bắt một
con ghi vào cây bị loại.

### `toolchain`: cache của SDK nằm ngoài workspace

Sandbox của launch read-only hoặc có scope chặn **mọi** ghi ngoài workspace, kể cả cache mà
toolchain buộc phải ghi để chạy — `flutter test` qua FVM ghi `~/fvm/versions/*/bin/cache`,
Gradle ghi `~/.gradle`, Xcode ghi `DerivedData`. GitHub #25: con `workspace-write` không
chạy nổi test của chính nó, và script của Flutter còn nuốt lỗi thành exit 0. Từ 0.16 máy khai
một lần trong **`~/.alp/settings.json`**:

```json
{ "toolchain": { "presets": ["flutter", "node"], "writePaths": ["~/fvm"] } }
```

- Preset (`flutter`, `node`, `rust`, `jvm`, `xcode`, `python`, `go`, bảng
  `TOOLCHAIN_PRESETS` trong `src/execution/toolchain.ts`) là danh sách thư mục cache quen
  thuộc dưới `$HOME`; đường nào không tồn tại trên máy thì bỏ qua. `writePaths` khai tay
  phải tồn tại, tuyệt đối hoặc `~/…`; `~`, `/` và bất kỳ đường nào chạm `~/.alp` bị từ chối.
- **Chỉ tầng máy.** `.alp/settings.json` hay `settings.local.json` của project mà có khối
  này thì phiên dừng với thông báo chỉ về file máy: một repo không được mở thư mục ngoài
  chính nó cho bất kỳ ai clone — cùng lý do `verify` phải qua `alp trust`, nhưng ở đây
  không có digest nào để trust.
- Mỗi đường được canonical qua symlink như workspace, sắp xếp, khử trùng, rồi vào
  `ExecutionPolicy.toolchainWritePaths` (`[]` khi không khai; snapshot cũ đọc lên cũng là
  `[]`) — trong `policyHash`, và hook bridge mang nó khi tái dẫn xuất. `authorize()` từ chối
  launch nếu một đường **chứa** workspace (mở cả cây cho vai read-only) hay **nằm trong**
  workspace (đó là scope, không phải cache); từ chối trước khi có gì trên đĩa.
- Enforcement: Claude thêm vào `sandbox.filesystem.allowWrite` cạnh `relay/` cho cả hai
  khối sandbox (read-only và có scope; `workspace-write` không scope không có sandbox nên
  không cần mở); Codex thêm một entry `"write"` mỗi đường vào profile, cả hai mode. Không
  đường nào nằm trong workspace, nên scope không đổi.

Chưa có tín hiệu riêng khi một lệnh bị sandbox chặn ghi (đề xuất 3 của #25) — agent vẫn chỉ
thấy `Operation not permitted` trên stderr.

### `--require-evidence`: cha nói trước nó sẽ tin cái gì

Con báo "xong" là **self-reported** — `state.json.output` do chính nó ghi. Từ 2026-09-17 cha
có thể khai trước thứ nó cần thấy:

```bash
alp delegate worker --write-scope src/parser \
  --require-evidence change --require-evidence verify:test -- "Sửa parser"
alp delegation wait exec_...        # thu evidence ngay khi node terminal
alp delegation evidence exec_...    # xem lại, hoặc thu tiếp phần còn `unknown`
alp trust verify                    # duyệt khối `verify.commands` của project này
```

Hai mục khai được: `change` (con **đã** đổi file, nhìn từ ngoài) và `verify:<id>` (lệnh
verify `<id>` của project chạy exit 0 sau khi con xong). Mục nào khác ⇒ `INVALID_REQUEST`
trước khi có node nào. `requiredEvidence` vào fingerprint của request và ở lại trên node,
nên hai lần gọi cùng task nhưng khác yêu cầu là hai request.

**Evidence được thu ở đúng hai chỗ**: `alp delegation wait` (ngay sau khi node terminal) và
`alp delegation evidence` (on-demand, hoặc thu lại phần còn `unknown` — ví dụ sau khi
`alp trust verify`). `status`, `tree`, `cancel`, reconcile **không bao giờ** thu: thu là chạy
lệnh verify trong workspace của người gọi, một câu hỏi đọc không được kéo `npm test`. Kết
quả ghi `<execution>/evidence.json` (`ExecutionEvidenceV1`, atomic), digest + verdict lên node
của cây, và `wait`/`evidence` trả `{ digest, evaluation, missing }`. Thread không nhận gì —
transcript delta của con nằm ở `<execution>/context/history/`, không vào `messages/`.

Mỗi item ghi **nguồn** và **độ tin** (`observed · derived · self-reported · unknown`):

| Item | Nguồn | `observed` khi | Ghi chú |
|---|---|---|---|
| `change` | `git` | không node nào khác có thể đã ghi cùng workspace (`ambiguousWith = []`) **và** `enforcement.writeIsolation = enforced` | `paths` = khác baseline chụp lúc `materialize` (status khác, hoặc hash khác với file dirty sẵn); `outsideScope` chỉ là bằng chứng khi `outsideScopeVerified` |
| `change`, `tool-call` | `history-bridge` | transcript đọc `complete` | `partial`/`final-only` ⇒ `derived`; `unsupported` ⇒ `unknown`. `tool-call.ref.result` = `{ digest, bytes, tail }` của output (GitHub #26) — xem dưới |
| `verify` / `verify-skipped` | `alp-verifier` | đã chạy | chưa trust ⇒ `verify-skipped untrusted`; timeout ⇒ `timeout`; không cấu hình ⇒ `not-configured` |
| `output` | `agent-output` | không bao giờ | `self-reported`, không đạt mục nào |
| `boundary` | `runtime-event` | luôn | |

Runtime chạy thật (`launch.json`) khác version đã đo (`enforcement.measuredOn`) ⇒ mọi
`observed` của git/bridge/event hạ xuống `derived`; verify do ALP tự chạy nên không hạ.
`ambiguousWith` liệt kê node khác cùng workspace, khoảng chạy giao nhau, mà có thể ghi được
(workspace-write với scope không rời, hoặc bất kỳ node nào không có `writeIsolation`
enforced — root read-only trên Windows luôn nằm trong danh sách). Một node đã kết thúc trước
khi verify bắt đầu không vào `ambiguousWith` của item `verify`.

Evaluator: mọi mục có item `observed | derived` khớp ⇒ `satisfied`; có mục không item nào ⇒
`unsatisfied` (`missing` kể tên); còn lại — item `unknown`, verify chưa chạy — ⇒ `unknown`.
`unknown` không phải đạt: cha thấy `unknown` là biết còn một việc (`alp trust verify`, chờ
verify) chứ không phải một kết luận. Request **không đòi gì** ⇒ `unevaluated` (từ 0.16, GitHub
#23) — trước đó ca này trả `satisfied`, và một con dừng giữa chừng không commit nhận đúng
verdict của một con đã commit + push. `wait --json` còn mang `evidence.changes[]` — mỗi item
`change` rút gọn thành `{ provenance, source, commit, pathCount, outsideScopeCount }` — để
coordinator phân biệt hai ca đó mà không phải gọi thêm `evidence`.

**`verify.commands` chỉ chạy sau khi principal duyệt.** Khối khai ở `.alp/settings.json` /
`.alp/settings.local.json` của project (tầng user không được — một lệnh verify thuộc về repo
chứa nó):

```json
{ "verify": { "commands": [ { "id": "test", "run": "npm test", "timeoutMs": 600000, "cwd": "." } ] } }
```

`alp trust verify` in từng lệnh và hỏi trên TTY; đồng ý thì ghi `{ project, verifyDigest }`
vào `~/.alp/trusted-verify.json` (một record một project, keyed theo realpath). Digest là
sha256 của `[id, run, timeoutMs, cwd]` sau khi gộp hai file — sửa một ký tự là phải trust
lại; `--revoke` rút. Lý do trust: lệnh chạy bằng process ALP **ngoài** sandbox runtime, trong
workspace của con, env chỉ `PATH`+`HOME`; một repo lạ mang `.alp/settings.json` không được
quyền chạy gì trên máy anh chỉ vì anh đã `alp delegate` vào nó.

### Disposition: con tự nói việc kết thúc thế nào

`status` nói process có sống hết không; `evidence` nói workspace có đổi không. Không cái
nào nói **con nghĩ việc đã xong chưa** — một worker viết "không làm được vì tiền đề sai"
vẫn là `completed` + `change satisfied`, và cha đọc prose kiểu gì cũng được (master plan 2a).
Từ 2026-09-19 con kết thúc báo cáo bằng một trailer máy đọc được:

```text
Disposition: done | blocked | reopen-request | dependency-request
Reason: <một câu>
Evidence: <đường dẫn, lệnh, request ID — cách nhau bằng dấu phẩy>
```

Con được nhắc trailer ở **hai chỗ**: luật trong identity của `worker` (`agents/worker.ts`)
và mục `## Report` khép lại `task.md` của *mọi* execution headless (`runtime/render-task-input.ts`).
Chỗ thứ hai có từ 2026-09-19: trailer là hợp đồng máy đọc của *từng execution*, không phải
nết của một vai — trong identity của `worker` nó là một trong mười luật, trong identity của
bốn specialist không có — nên nó đứng ở chỗ model đọc cuối cùng. Thứ model đọc cuối là thứ
nó làm cuối.

Hook Stop (`finalizeExecution`) đọc trailer từ đuôi output **đã qua validation** và ghi
`state.json.outcome = { disposition, reason, evidenceRefs }` (`execution/outcome.ts`).
Trailer bắt đầu ở dòng `Disposition:` cuối cùng; `Reason:`/`Evidence:` chỉ đọc sau dòng đó,
nên phần thân được nhắc tới chữ này. `reason` qua `history-redact`, cắt 2 000 byte;
`evidenceRefs` tối đa 20 mục, mỗi mục 500 byte — chúng là *lời con khai*, ALP không kiểm.

Bốn quy tắc đọc:

- **Thiếu trailer ⇒ `unknown`, không phải `done`.** Con chết trước Stop hook, output trượt
  validation, hay `state.json` của `alp` trước 2a — tất cả đọc là `unknown`. Cha không được
  suy "không nói gì" thành "đã xong".
- Giá trị ngoài bảng cũng là `unknown`, giữ `reason` để người đọc thấy con định nói gì.
- `outcome` **không** đi qua graph: nó đọc từ `state.json` của chính node, có ngay khi con
  dừng, không cần `wait` hay thu evidence. `wait`/`status` (`DelegationResult.outcome`) chỉ
  có khi execution đã terminal; `tree` in `disposition …` trên mọi node đã dừng (`--json`:
  `outcome` trên node, `null` khi chưa dừng).
- Disposition không đổi `status`, không đổi `evaluation`, không chặn gì. Nó là câu hỏi thứ
  ba cha phải đọc cạnh hai câu kia.

#### Contract Peer: nghĩa từng disposition (master plan 2c)

`worker` sở hữu **outcome**, không sở hữu nghĩa vụ hoàn thành (vision §4.13). Prompt của nó
nói việc kết thúc thế nào, và prompt của `main` nói đọc thế nào — đây là phần duy nhất của
SLP cần đổi prompt, và nó đổi *cách kết thúc* chứ không đổi quyền:

| Disposition | Con nói | Cha (`main`) làm |
|---|---|---|
| `done` | task **như đã viết** xong và đã verify | kiểm evidence rồi `accept`/`reject` |
| `reopen-request` | premise sai — file, symbol, bug task nêu không như mô tả; con **không sửa gì** và đưa bằng chứng | dữ liệu về framing của *chính cha*, không phải bất tuân: đọc `evidenceRefs`, sửa task, giao lại — không gửi lại nguyên task |
| `dependency-request` | thiếu input — file, quyết định, approval, kết quả của execution khác | cấp (hoặc đem lên principal) rồi giao lại |
| `blocked` | premise đúng nhưng thứ ngoài quyền con chặn — write bị deny, prerequisite con không được chạm | gỡ (scope, approval, prerequisite) rồi giao lại |
| `unknown` | không nói gì | chưa xong; đọc prose + evidence, coi là chưa verify |

Luật của `worker`: kiểm premise **trước** khi đổi gì (file, symbol, hành vi task nêu phải tồn
tại như mô tả); bằng chứng nói ngược thì không lách, không sửa cái task không nêu — để nguyên
workspace và trả `reopen-request` kèm bằng chứng. Không bao giờ khai `done` cho việc làm một
phần hay làm theo cách hiểu khác. Một `reopen-request` sạch là kết quả tốt hơn một thay đổi
khớp với premise sai. Khối assignment (`Objective / Owned paths / Excluded paths /
Verification`, mục 2b) là biên của nó: verification thì con tự chạy trước khi báo cáo.

Luật của `main`: đọc `outcome.disposition` từ `wait --json` **trước** prose — `status:
completed` chỉ nói process đã sống hết; và giao mọi task cho `worker` dưới dạng assignment
(`--objective`, `--write-scope`/`--exclude-scope`, `--verification`).

Fixture tầng 4 (`test/fixtures/live/wrong-premise/`, chạy bằng `node
scripts/live-worker-premise.cjs` **từ trong một phiên ALP**): task nói `parseHeader` ném
`TypeError` với input rỗng, nhưng test của chính project chứng minh nó không ném. Đạt khi
`outcome.disposition` là `reopen-request` có `evidenceRefs` và bản chép sạch (`git status`
rỗng). Phần phán (`scripts/lib/live-fixture.cjs`) và baseline xanh của fixture được unit
test mỗi commit; lần chạy thật thì khi `worker.ts`/`main.ts` đổi (vision §10.3).

### `alp delegation accept|reject`: cha nghiệm thu, ALP ghi phán quyết

Evidence trả lời "đã xảy ra gì"; nó chưa trả lời "cha có nhận kết quả này không". Từ
2026-09-17 cha đóng vòng bằng một hành động **được xác thực**:

```bash
alp delegation accept req_...  [--reason "..."]...  [--json]
alp delegation reject req_...   --reason "..."  [--reason "..."]...  [--json]
```

Khoá là **request ID** (thứ `alp delegate` trả về và `tree` in `req …`), không phải execution
ID: cha nghiệm thu *việc nó đã giao*, không phải một node nó tình cờ biết ID. Trình tự, theo
thứ tự từ chối:

1. Binding cha đọc từ env (`readBindingFromEnvironment`) → `graph.authenticateParent`; sai ⇒
   `CAPABILITY_INVALID`. Không có cách nào nghiệm thu từ ngoài cây.
2. Request phải là **con trực tiếp** của node cha; cháu, anh em, chính mình, hay request của
   root khác ⇒ `ACCEPTANCE_NOT_PARENT` (từ CLI thì `EXECUTION_NOT_FOUND` — cây khác không lộ
   node của nó).
3. Con phải đã terminal: `queued`/`running` ⇒ `ACCEPTANCE_SUBJECT_RUNNING`. Muốn từ chối một
   con đang chạy thì `cancel` trước rồi `reject`.
4. Một request quyết đúng **một** lần: `ACCEPTANCE_ALREADY_DECIDED`. Không có "đổi ý" — đổi
   ý là giao lại.
5. `reject` bắt buộc `--reason`; `accept` thì tuỳ. Lý do rỗng ⇒ `INVALID_REQUEST` trước khi
   động vào gì.

Ba guard trên chạy **trước** khi thu evidence: một lệnh bị từ chối vì thẩm quyền không được
kéo `npm test`. Qua guard rồi, `accept` lẫn `reject` đều thu evidence nếu chưa có (idempotent
với `wait`) — phán quyết luôn trỏ tới một `evidence.json` cụ thể qua `evidenceDigest`, kể cả
khi cha chưa từng `wait`. Evidence thu lỗi ⇒ lệnh lỗi, không có phán quyết mù.

Kết quả ghi ở hai chỗ, cả hai do ALP viết:

- **Node của cây**: `acceptance = { decision, evidenceDigest, decidedAt }`, revision +1, status
  không đổi (một con `failed` được `accept` vẫn là `failed` — nghiệm thu không viết lại lịch
  sử). Invariants từ chối graph có `acceptance` trên node còn active hay trên root.
- **Record**: `<executions>/<parent>/acceptance/<requestId>.json` (`AcceptanceRecordV1`, 0600,
  atomic) mang thêm `reasons` — mỗi lý do đi qua `history-redact`, cắt ở 2 000 byte — và
  `disposition`: cái con khai **lúc cha quyết** (2a), để "cha thấy `reopen-request` mà vẫn
  `accepted`" là một sự thật ghi lại được; record trước 2a đọc là `unknown`. Record nằm
  dưới thư mục **cha**, vì phán quyết là của cha; `cleanup` con không xoá nó.

Phán quyết hiện ở mọi chỗ cha nhìn: `tree` thêm `decision accepted|rejected` (hoặc
`decision undecided` cho con đã kết thúc mà chưa ai quyết), `accept|reject` in
`disposition …` cạnh `evidence …` trên dòng phán quyết, `evidence` in dòng `decision …`,
và — quan trọng nhất — **Thread context** của lần chạy sau (xem § "Phán quyết vào Thread").
Cùng dòng `tree` còn có `usage …` và `budget …` của node (xem § "Usage và budget").

### Usage và budget: đếm sau, không chặn giữa chừng

Mỗi execution biết nó tốn bao nhiêu — **đọc từ transcript** qua đúng history bridge đã mở
cho evidence, không qua hook mới, không qua `-p`/stream-json. Năm cột tách riêng, không
cộng thành một số "tổng" trong contract vì cache token mỗi runtime đếm khác nhau:

```text
inputTokens · outputTokens · cacheReadTokens · cacheWriteTokens · toolCalls
```

Một cột **`null` là "không đếm được"**, không phải 0 — bridge gặp dòng không đọc nổi thì
đặt cột đó `null` cho cả lát, và `null` lan qua phép cộng (một lát mù ⇒ tổng mù). Claude
đếm theo `message.id` vì CLI 2.1.268 ghi một API message thành nhiều dòng JSONL cùng `id`
cùng `usage`; Codex đọc `event_msg`/`token_count`. Version ngoài pin của bridge ⇒
completeness hạ như entries, không phải số bịa.

- **Con:** `wait()`/`evidence()` chạy bridge, cộng dồn vào `<execution>/usage.json`
  (`ExecutionUsageV1`) và ghi lên graph node — `alp delegation tree` in từng node và tổng
  cây không mở file. Lần thu sau chỉ nhận dòng sau cursor, nên bridge chạy hai lần không đếm
  đôi; bridge còn `final-only`/`unsupported` thì lần thu sau vẫn thử lại.
- **Root:** `collectHistory` cộng `usageDelta` vào `history.usage` của `ThreadExecutionRef`
  dưới Thread lease, cùng commit với cursor — hoặc cả hai tiến, hoặc không. `settleRoot`
  chép sang boundary; `alp thread show` in `usage in … out … cache r/w … tools …`.

`--budget-tokens N` / `--budget-tool-calls N` (số nguyên dương, vào fingerprint request)
được đánh giá **sau** khi con xong:

| `budgetStatus` | Khi |
|---|---|
| `exceeded` | một trần bị vượt bởi số **đã đếm được** (`>` ngặt) |
| `unknown` | không trần nào bị vượt, nhưng một trần không so được vì cột `null` |
| `within` | mọi trần so được và không vượt — kể cả khi không khai trần |

`exceeded` là **evidence, không phải lỗi**: nó thành item `usage` trong `evidence.json`
(`{usage, budget, status}`), in ở `alp delegation evidence` và `tree` (`budget exceeded`),
cha thấy khi nghiệm thu — nhưng không đổi outcome của con, không đổi `evaluation`, không
chặn tool call thứ N+1. Chặn giữa chừng cần `PreToolUse` hook (đã bỏ có chủ đích) và Codex
không có tương đương — đó là ADR riêng, không nằm trong đây.

### Phán quyết vào Thread: nguồn thứ hai, không phải pin

Projector Thread có đúng hai nguồn: pin của agent (`checkpoint.json`) và **delegations do ALP
ghi**. Khi root settle, `ThreadService.projectContext` đọc cây của root đó (ngoài lease) và
đưa mọi con trực tiếp vào snapshot, 20 cái mới nhất theo `createdAt`:

```text
## Delegations of E-3 (ALP-recorded)
- req_7 → worker: accepted (evidence 3f9c0a1b2c3d…) — Sửa parser cho input rỗng
- req_8 → review: rejected (evidence 91a0…) — Review patch parser
- req_9 → search: undecided — Tìm chỗ gọi parser
```

Dòng này agent **không viết được**: pin viết "đã accept" chỉ là một pin; mục ở đây chỉ có khi
graph có `acceptance`. `undecided` được in ra chứ không giấu — con đã xong mà cha chưa quyết
là một việc còn nợ, và rule của `main` bắt nó đóng mọi delegation bằng `accept`/`reject`.
`cancelled` cũng là một kết cục (`decision: cancelled`) để lượt sau không giao lại việc đã bị
huỷ có chủ ý. `alp thread context|show` in cùng danh sách dưới `Delegations (ALP-recorded):`;
history boundary của root mang đếm `{ accepted, rejected, cancelled, undecided }`.

Cắt tất định khi quá 32 KiB: outcomes cũ rớt **trước**, delegations rớt sau cùng (cũ nhất
trước) — phán quyết là thứ đắt nhất trong snapshot vì không tái tạo được từ pin. Snapshot không
có delegation thì không có field: digest của mọi snapshot cũ giữ nguyên.

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
alp delegate worker --budget-tokens 20000 --budget-tool-calls 30 -- "Sửa parser"   # observe-only

alp delegation tree     exec_...  [--json]
alp delegation status   exec_...
alp delegation wait     exec_...
alp delegation evidence exec_...  [--json]
alp delegation accept   req_...   [--reason "..."]... [--json]
alp delegation reject   req_...    --reason "..."     [--json]
alp delegation cancel   exec_...
alp delegation cleanup  exec_...
alp delegation list
alp trust verify [--project <path>] [--revoke]
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
`requestId` để nối lại với lệnh đã gọi, và — khi request có `--require-evidence` — verdict
đã thu (`evidence unevaluated|satisfied|unsatisfied|unknown`) hoặc `evidence pending` nếu chưa ai `wait`.
Con đã kết thúc còn mang `decision accepted|rejected`, hoặc `decision undecided` khi cha chưa
`accept`/`reject`.

`evidence` in kết luận trước, rồi từng mục đã đòi, rồi từng item với nguồn và độ tin:

```text
evidence exec_worker  ·  satisfied  ·  collected 2026-09-17T02:14:05.000Z
digest 3f9c…  ·  history complete
required: change  ·  present
required: verify:test  ·  present
decision accepted  ·  2026-09-17T02:20:11.000Z

  change         observed      git  2 path(s)
  change         observed      history-bridge  2 path(s)
  tool-call      observed      history-bridge  Write {"file_path":"src/parser/new.ts",…}  · result 2 B
  tool-call      observed      history-bridge  Bash {"command":"npm test"}  · error  · result 53 B
      │ FAIL src/parser/new.test.ts
      │ Tests: 1 failed, 2 passed
  verify         observed      alp-verifier  verify:test exit 0 in 8123 ms
  output         self-reported agent-output  digest 91a0…
  boundary       observed      runtime-event  completed · history complete
```

**Tool result trong evidence (GitHub #26).** Trước đây bridge chỉ đọc `is_error` của
`tool_result`, nên item `tool-call` chỉ có tên tool và cha phải mở log của backend để biết
`npm test` nói gì. Nay `ref.result = { digest, bytes, tail }`: digest sha256 của toàn bộ
output **sau redaction** (cái người đọc có thể đối chiếu), kích thước, và
`HISTORY_TOOL_RESULT_TAIL_MAX_BYTES` (2 KB) cuối — đuôi chứ không phải đầu, vì đó là chỗ
kết quả nằm. Redact chạy trước digest và trước cắt. Codex không có cờ lỗi: bridge mở envelope
`{ output, metadata: { exit_code } }` của shell, `exit_code ≠ 0` ⇒ `isError`. Result chỉ gắn
được khi cùng lát đọc với `tool_use` — với con (thu một lần sau khi settle) là luôn luôn;
entry ghi trước khi có trường này vắng `result`. Text view chỉ in 3 dòng cuối cho call
**lỗi** để không ngập trong `ok` của mỗi Read; `--json` có nguyên đuôi của mọi call.
`wait --json` mang bản rút gọn: `evidence.toolCalls` (đếm) và `evidence.toolErrors[]`
(`name`, `summary`, `tail`; tối đa 5, theo thứ tự transcript) — đủ để cha thấy "con nói
`done`, test nói fail" mà không gọi thêm `evidence`.

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

### Runtime cưỡng chế được gì — bảng đo, không phải lời hứa

Bảng Authority mà một role đọc là *một* lời hứa viết hai lần: Claude từ chối tool ngoài
grant lúc gọi, Codex thì shell là built-in và đọc được mọi path. `src/runtime/capabilities.ts`
giữ điều đó thành dữ liệu có `measuredOn { platform, runtimeVersion, measuredAt }`, và
`ExecutionPolicy.enforcement` chụp đúng dòng đã dựa vào **vào `policyHash`** — hai policy
khác nhau ở mức cưỡng chế là hai identity khác nhau. Bốn mức: `enforced` (runtime tự từ chối),
`partial` (runtime từ chối những gì ALP liệt kê được lúc phóng, không hơn — biên là một danh
sách chứ không phải một luật, nên thứ xuất hiện sau khi liệt kê không bị chặn), `declared-only`
(ALP nói ra, không ai từ chối), `none` (không cưỡng chế **hoặc chưa đo** — ô chưa đo là `none`,
không chép từ platform bên cạnh).

| | toolGrant | readIsolation | writeIsolation | writeScope | networkEgress | nativeDelegationDeny |
|---|---|---|---|---|---|---|
| codex · darwin/linux (đo trên 0.154, 2026-09-18) | declared-only | none | enforced | enforced | enforced | enforced |
| codex · win32 | declared-only | none | none | none | none | enforced |
| claude · darwin/linux (đo trên 2.1) | enforced | enforced | enforced | partial (đo 2026-09-12 trên 2.1.269) | declared-only | enforced |
| claude · win32 | enforced | declared-only | none | declared-only | declared-only | enforced |

**Sandbox của Codex đi trên argv, không qua file.** Adapter vẫn ghi `codex-config.toml`
(model, hooks, rules — là file *của ALP*, để `alp doctor`/debug đọc), nhưng Codex không load
nó: mọi thứ phải bind đều đi bằng `-c`. Từ 2026-09-18 launch mang `-c
default_permissions="alp"` + `-c permissions.alp.filesystem={…}` với `":root"="read"`,
`<execution>/relay` write, write roots (scope hoặc workspace + private memory của vai),
`/tmp`/`$TMPDIR` khi `workspace-write`, và `.git`/`.agents`/`.codex` dưới mỗi write root là
`read` — đúng hình `workspace_write` của Codex tự dựng; cộng `approval_policy="never"`. Không
`-s <mode>` (profile thắng `sandbox_mode` trọn vẹn), và phiên interactive không còn
`--dangerously-bypass-approvals-and-sandbox`. Profile không có mục `network` ⇒ Codex chặn
mạng kể cả khi vai được grant `WebFetch` — grant đó trước giờ cũng chưa từng mở được mạng
trên Codex; mở nó cần `[permissions.alp.network]`, chưa làm.

`describeEnforcement(caps, policy)` sinh dòng giải thích cho bảng của `alp agent test` /
`alp agent add` từ chính dữ liệu này, nên không thể lệch với nó. Tầng 2 của `alp agent test`
còn *đo lại* trên máy đang chạy: `codex sandbox` ghi một file ngoài writable roots (dưới
`$HOME/.alp/`, không phải `/tmp` — Codex cho ghi `/tmp` mặc định) và đọc một file ngoài
workspace ở `read-only`; sai với bảng ⇒ `DRIFT(<runtime> <field>: table says X, measured Y)`
và exit ≠ 0. Claude không probe được ngoài phiên model; Windows không có dòng nào để probe.

### Launch receipt — binary nào đã thật sự chạy

Backend ghi `<execution>/context/launch.json` (`LaunchProvenanceV1`) **trước** khi spawn,
nên process crash vẫn để lại receipt; nằm trong `context/` để sống qua dọn `runtime/`.
`runtimeVersion` lấy từ `<runtime> --version` với budget 2s, cache theo path + mtime của
binary, hỏng ⇒ `"unknown"`. `authMethod` chỉ nhìn *sự tồn tại* của env/file (Claude:
`ANTHROPIC_API_KEY` → `api-key`; `CLAUDE_CODE_OAUTH_TOKEN`, `.credentials.json` hoặc item
keychain macOS → `oauth`. Codex: `OPENAI_API_KEY` → `api-key`; `~/.codex/auth.json` →
`oauth`), không bao giờ đọc giá trị. `launchSpecDigest` băm command/args/cwd và **tên** biến
env — giá trị có thể là secret. Receipt không vào `policyHash`: nó là sự kiện, không phải
quyết định. Version lệch `measuredOn` **không chặn** launch — chặn là ALP chết mỗi lần CLI
update; `alp doctor` in "not re-measured for <version>" và `alp thread show` in
`ran <runtime> <version> (<auth>)` cho từng execution.

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
| `APPROVAL_UNAVAILABLE` · `APPROVAL_DENIED` | policy cần principal trả lời mà không có surface nào hỏi được, hoặc principal đã nói "no" — xem "`--workspace` ngoài grant" ở trên |
| `WRITE_SCOPE_ON_READ_ONLY` · `WRITE_SCOPE_NOT_FOUND` · `WRITE_SCOPE_OUTSIDE_WORKSPACE` · `WRITE_SCOPE_PROTECTED_ROOT` · `WRITE_SCOPE_EXCEEDS_PARENT` | `--write-scope` không hợp lệ — xem bảng ở "`--write-scope`" ở trên |
| `EXCLUDE_SCOPE_ON_READ_ONLY` · `EXCLUDE_SCOPE_NOT_FOUND` · `EXCLUDE_SCOPE_OUTSIDE_WRITE_SCOPE` · `EXCLUDE_SCOPE_COVERS_WRITE_SCOPE` | `--exclude-scope` không hợp lệ — xem "Assignment có biên" ở trên |
| `WRITE_SCOPE_OVERLAP` | Một execution đang sống trong cùng graph đã sở hữu vùng con xin ghi — thu hẹp scope, `--exclude-scope` vùng đó, hay đợi |

Một node chết không đẹp còn mang mã của riêng nó — thứ `tree` in ra sau execution ID:
`ROOT_START_FAILED` và `CHILD_START_FAILED` (backend từ chối spawn sau khi chỗ đã được giữ),
`EXECUTION_NEVER_STARTED` (`queued` quá lâu mà backend chưa từng biết tới nó — caller đã chết
giữa chừng) và `EXECUTION_INTERRUPTED` (có process, rồi không còn, không ai ghi kết cục).

## Ngoài phạm vi P0

Ba thứ hay bị đọc nhầm là đã có:

- **Token budget và tool-call budget.** Có **đếm** (2026-09-17, § "Usage và budget") nhưng
  không cưỡng chế: `--budget-*` chỉ cho `exceeded` sau khi con xong. Trần *cưỡng chế* của
  P0 đếm *execution* — depth, số con, đồng thời, lượt giao việc, wall clock — chứ không đếm
  token hay lượt gọi tool. Một cây trong trần vẫn tiêu bao nhiêu token tuỳ nó.
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

Doctor in `ENFORCEMENT-CLAUDE` / `ENFORCEMENT-CODEX`: version binary trên PATH, auth method
sẽ dùng, dòng bảng enforcement của platform này, và cảnh báo khi bảng đo trên version khác —
luôn là observation, không phải finding, vì version mới không phải cài đặt hỏng.

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
