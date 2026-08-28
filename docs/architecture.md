# Kiến trúc alp-code

> Tài liệu kiến trúc hệ thống. Mô tả layer, contract giữa các layer, luồng dữ liệu và các
> ranh giới tin cậy. Cập nhật từ source tại `main` (2026-08-27).

## 1. Hệ thống này là gì

ALP là **launcher code-native cho một nhóm agent**. Nó không phải framework agent, không phải
runtime, không phải backend. Nó là lớp quyết định *ai được làm gì, ở đâu, với dữ liệu nào* —
rồi dịch quyết định đó thành một lệnh khởi chạy cho Claude Code hoặc Codex CLI.

Ba invariant định hình toàn bộ thiết kế:

| Invariant | Hệ quả kiến trúc |
|---|---|
| **Identity là code, không phải Markdown** | Agent định nghĩa trong TypeScript, freeze khi load, hash vào execution policy |
| **ALP quyết ai giao việc cho ai; backend chỉ quyết execution chạy thế nào** | Policy chạy trước mọi runtime probe / backend health / spawn |
| **Fail-closed** | Unknown tool/path/role/request → deny. Không có nhánh "mặc định cho phép" |

Runtime (Claude/Codex) và backend (local/Paseo) đều là **plugin thay được**, không phải
nguồn sự thật của identity hay quyền.

## 2. Sơ đồ layer

```text
┌──────────────────────────────────────────────────────────────────────┐
│  cli/            alp.ts · commands/{run-main,delegate,init,runtime}  │
│                  parse argv → composition root → exit code           │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│  delegation/     DelegationService · BackendRegistry                 │
│                  normalize request · pin backend · route result      │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│  execution/      ExecutionService — deny-first orchestrator          │
│                  ExecutionPolicy (snapshot + hash)                   │
│                  IdentityCapsule (immutable bundle gửi cho runtime)  │
└──┬──────────────┬──────────────┬──────────────┬──────────────────────┘
   │              │              │              │
┌──▼────────┐ ┌───▼────────┐ ┌───▼────────┐ ┌───▼──────────────────────┐
│ agents/   │ │ policy/    │ │ memory/    │ │ workflow/                │
│ registry  │ │ PolicyEng. │ │ MemorySvc  │ │ WorkflowRunner           │
│ immutable │ │ fail-closed│ │ + adapters │ │ state machine + contract │
└───────────┘ └────────────┘ └────────────┘ └──────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│  runtime/        ClaudeRuntimeAdapter · CodexRuntimeAdapter          │
│                  PreparedExecution → RuntimeLaunchSpec               │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│  backend/        ExecutionBackend contract                           │
│                  LocalProcessBackend (TS) · Paseo (CJS adapter)      │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│  hooks/          session-boot.cjs (SessionStart) · session-end (Stop) │
│                  → src/hooks/execution-bridge.ts                     │
│                  enforce policy *bên trong* tiến trình runtime       │
└──────────────────────────────────────────────────────────────────────┘
```

Luật phụ thuộc: layer trên import layer dưới, không bao giờ ngược lại. `policy/` không biết
runtime; `agents/` không biết backend; `memory/` không biết execution.

## 3. Hai luồng chính

### 3.1 `alp` — phiên main tương tác

```text
alp [--runtime claude|codex]
  → parseAlpArgs                       (cli/alp.ts)
  → RuntimeSelector.select             (explicit | interactive TTY | persisted | default)
  → ProjectRegistryStore.isRegistered  → workspace-write nếu đã `alp init`, else read-only
  → ExecutionService.prepare           (parent = "principal", target = "main")
       ├─ assert main.reportsTo === "principal"
       ├─ PolicyEngine.authorize({ type: "workspace", ... })
       ├─ MemoryService.buildContext
       ├─ WorkflowRunner.initialize
       ├─ createExecutionPolicy   → snapshot + definitionHash + policyHash
       ├─ createIdentityCapsule   → lọc memory theo grant, cắt tool theo workflow state
       └─ FileExecutionStore.create → ~/.alp/executions/<id>/{policy,state}.json  (0600)
  → RuntimeAdapter.probe               (binary có trên PATH không)
  → RuntimeAdapter.prepare             → RuntimeLaunchSpec (command/args/cwd/env/tmpfiles)
  → LocalProcessBackend.spawn + wait
  → đọc lại state.json → status/output cuối cùng
```

Exit code: `0` completed · `130` cancelled · `1` còn lại.

### 3.2 `alp delegate <role>` — giao việc cho specialist

```text
alp delegate review --project /path -- "Review the diff"
  → runDelegateCommand                 (parse flag, parentRole từ env ALP_DELEGATED_ROLE)
  → DelegationService.delegate
       ├─ normalizeRequest             (validate, sinh requestId/executionId)
       ├─ ExecutionService.prepare     ← DENY-FIRST, trước mọi thứ khác
       │    └─ PolicyEngine.authorize({ type: "delegation", actor, target })
       │         · target ∈ actor.delegatesTo ?
       │         · target.reportsTo === actor ?
       ├─ resolve runtime adapter      (request override → config.defaultRuntime)
       ├─ adapter.prepare              → launch spec, model/effort lấy từ definition
       ├─ resolveBackend               (health check; fallback CHỈ trước spawn)
       ├─ executionStore.put           (pin backend vào record)
       └─ backend.spawn
  → nếu không --background: service.wait(executionId)
```

Điểm quan trọng: `ExecutionService.prepare` được gọi **trước** khi resolve runtime, trước
health check backend, trước khi tạo execution record. Delegation không được phép làm rò rỉ
sự tồn tại của backend cho một request đã bị policy từ chối.

## 4. Chi tiết từng layer

### 4.1 `src/agents/` — registry bất biến

`AgentDefinition<TOutput>` là đơn vị identity:

```ts
{ id, displayName, model: {claude, codex}, reasoningEffort: {claude, codex},
  reportsTo, delegatesTo, capabilities: {tools, memory, workspace},
  instructions(), workflow, output }
```

`defineAgent()` deep-clone rồi `Object.freeze` đệ quy — definition không thể bị mutate sau khi
load, kể cả bởi code trong cùng process.

`createAgentRegistry()` validate khi load, throw `AgentRegistryError` nếu:

| Kiểm tra | Mã lỗi |
|---|---|
| id trùng | `DUPLICATE_AGENT` |
| id/displayName/model/workflow rỗng, effort không hợp lệ | `INVALID_AGENT` |
| tool ngoài `TOOL_CATALOG` | `UNKNOWN_TOOL` |
| workspace write root không nằm trong read root | `INVALID_WORKSPACE_GRANT` |
| memory write grant không được read grant bao phủ | `INVALID_MEMORY_GRANT` |
| `private:<other>` trong grant của agent khác | `INVALID_MEMORY_GRANT` |
| `reportsTo`/`delegatesTo` trỏ agent không tồn tại | `UNKNOWN_RELATION` |
| self-delegation hoặc chu trình delegation | `INVALID_DELEGATION` |

Registry là **DAG**, kiểm bằng DFS 3 màu (`assertNoDelegationCycles`).

Loadout hiện tại:

| Agent | Claude / Codex | Effort | Tools | Memory write | Workspace |
|---|---|---|---|---|---|
| `main` (Phở 🍜) | opus-5 / gpt-5.6-sol | high / xhigh | tất cả 9 | shared, project:\*, private:main | read + write |
| `search` | sonnet-5 / terra | low / low | Read Glob Grep Bash Skill | private:search | read |
| `librarian` | opus-5 / sol | high / high | + WebSearch WebFetch | shared:reference:\*, project:\*:refs:\*, private | read |
| `read-thread` | haiku-4-5 / luna | low / low | Read Glob Grep Skill | private:read-thread | — |
| `review` | opus-5 / gpt-5.5 | high / medium | Read Glob Grep Bash Skill | private:review | read |
| `oracle` | opus-5 / sol | high / xhigh | + WebSearch WebFetch | private:oracle | read |
| `compaction` | opus-5 / sol | medium / medium | Read Glob Grep | private:compaction | — |
| `titling` | haiku-4-5 / luna | low / low | — | private:titling | — |

Chỉ `main` có `delegatesTo` khác rỗng. Cây delegation phẳng: `principal → main → {7 specialist}`.

`shared/` chứa phần dùng chung: `house-rules.ts` (4 quy tắc code-native),
`voice.ts` (`renderInstructions` — khuôn prompt thống nhất), `principal.ts` (ngôn ngữ/timezone
của principal).

### 4.2 `src/policy/` — authorization fail-closed

`PolicyEngine.authorize(request)` là **cửa duy nhất**. Năm loại request:

| Type | Quyết định bởi | Deny code chính |
|---|---|---|
| `delegation` | `DelegationPolicy` | `DELEGATION_NOT_ALLOWED`, `DELEGATION_PARENT_MISMATCH` |
| `memory` | `MemoryPolicy` | `PRIVATE_MEMORY_DENIED`, `MEMORY_NOT_GRANTED` |
| `workspace` | `WorkspacePolicy` | `WORKSPACE_NOT_GRANTED`, `WORKSPACE_READ_ONLY`, `WORKSPACE_SCOPE_MISMATCH` |
| `configuration` | luôn deny | `POLICY_MUTATION_DENIED`, `DEFINITION_MUTATION_DENIED` |
| `tool` | `invariants.ts` + capability | `RAW_RUNTIME_TOOL_DENIED`, `INDIRECT_TOOL_REQUEST`, `TOOL_NOT_GRANTED` |

`switch` kết thúc bằng `default: deny("UNKNOWN_REQUEST")`; actor lạ → `UNKNOWN_ACTOR` ngay dòng đầu.

**Workspace policy** canonicalize path bằng `realpathSync` (chống symlink escape) và áp thêm
một tầng cho delegated execution: path phải nằm trong `activeWorkspace` của lượt này, kể cả
khi nó vẫn thuộc `readRoots` của agent. Một specialist có `readRoots: ["."]` vẫn không đọc
được workspace khác trong cùng lượt delegation.

**Memory grant** dùng wildcard theo segment (`memory-grant.ts`): `shared` bao mọi `shared:*`;
`project:*` bao mọi project; `shared:reference:*` bao mọi entry dưới reference. `private:<role>`
chỉ khớp đúng owner.

**Tool invariants** (`invariants.ts`) chặn hai lớp bypass:
- `isRawRuntimeTool` / `invokesRawRuntime` — tool hoặc lệnh gọi `herdr`/`paseo`/`create_agent`/
  `spawn_agent`, kể cả qua `env`/`command`/`sudo` hoặc đường dẫn đầy đủ.
- `hasIndirectCommand` — `eval`, backtick, `$(...)`, process substitution, `base64`, `sh -c`,
  `xargs`… những thứ khiến việc inspect lệnh trở nên vô nghĩa.

Source ghi rõ giới hạn (`POLICY_GUARDRAIL_LIMITATION`): đây là guardrail, không phải sandbox
chống tiến trình thù địch.

### 4.3 `src/memory/` — storage-neutral

Agent không bao giờ thấy đường dẫn file. Chúng dùng **logical ID**:

```text
shared:<path...>            → memory/shared/<path>.md
project:<slug>:<path...>    → memory/projects/<slug>/<path>.md
private:<role>:<path...>    → memory/private/<role>/<path>.md
```

`MemoryService` authorize → gọi store → ghi audit event, cho cả 5 thao tác
(`search|get|create|update|delete`). Deny cũng được audit. `search` còn lọc kết quả lần hai
theo grant, đề phòng store trả rộng hơn query.

`buildContext()` là đường vào của execution: gộp kết quả nhiều query, khử trùng theo ID,
rank bằng `DeterministicContextRanker` (term match → `updatedAt` desc → ID asc, hoàn toàn
tất định), rồi cắt theo `characterBudget` và báo cáo `omittedEntryIds`.

Hai adapter cùng implement `MemoryStore`:

| Adapter | Lưu ở | Ghi chú |
|---|---|---|
| `MarkdownFileStore` | `memory/**.md` + metadata index | Mặc định. Optimistic versioning, atomic rename |
| `RemoteApiStore` | qua `MemoryApiClient` injected | Cùng contract, sẵn cho server-backed memory |

`MemoryPathMapper` chống path escape ba lớp: kiểm ID hợp lệ khi parse, kiểm path nằm trong
root sau `join`, và `realpath` cả parent lẫn target để bắt symlink.

`memory/` **không đi theo Git**. Bootstrap chỉ chép phần thiếu từ `scaffold/memory/`.

### 4.4 `src/execution/` — snapshot bất biến

Đây là trung tâm của mô hình bảo mật. Ba artifact được sinh cho mỗi lượt chạy:

**`ExecutionPolicy`** — snapshot quyền tại thời điểm prepare, kèm hai hash:
- `definitionHash` = SHA-256 của definition đã canonicalize (bao gồm cả *source của hàm*
  `instructions` và `validate` — sửa logic prompt sẽ đổi hash).
- `policyHash` = SHA-256 của chính snapshot.

**`IdentityCapsule`** — bundle gửi cho runtime: instructions đã render, task, workspace,
memory đã lọc, workflow state, `allowedTools` = giao của capability grant và tool cho phép ở
state hiện tại, JSON Schema của output contract.

**`StoredExecutionState`** — trạng thái tiến triển, ghi vào `state.json`.

`FileExecutionStore` ghi qua staging directory + atomic `rename`, mode `0700`/`0600`, và từ
chối nếu execution ID đã tồn tại hoặc chứa separator.

### 4.5 `src/workflow/` — state machine + output contract

Mỗi agent có một workflow tuyến tính (`defineLinearWorkflow`) với tool set thu hẹp dần theo
state. Ví dụ `main`: `ASSESS` (chỉ đọc) → `EXECUTE` (đầy đủ) → `VERIFY` (đọc + Bash) →
`REPORT` (không tool).

`WorkflowRunner` quản `running → awaiting-output → completed | repairing → failed`, kèm
`cancelled`. `MAX_OUTPUT_REPAIR_ATTEMPTS = 1` — thiếu output được sửa đúng một lần rồi fail.

Output contract là `textOutput(name)` (`src/agents/shared/voice.ts`): agent trả **prose**,
contract chỉ từ chối chuỗi rỗng. Trước đây contract dựng từ Zod và nhúng JSON Schema vào
prompt, buộc agent trả đúng một JSON value — kể cả vai `main` vốn nói chuyện trực tiếp với
principal. Máy móc không đọc field lẻ nào của output đó, nên ràng buộc chỉ đổi lấy một
regression trải nghiệm. `defineOutputContract` vẫn còn cho trường hợp cần schema thật.

### 4.6 `src/runtime/` — dịch sang launch spec

`RuntimeAdapter` có hai method: `probe()` (binary có trên PATH?) và `prepare()` →
`RuntimeLaunchSpec { command, args, cwd, env, temporaryFiles }`.

Cả hai adapter ghi vào `~/.alp/executions/<id>/runtime/` (atomic, `0600`):
`identity-capsule.json`, `prompt.md`, `skill-roots.json`, và file config riêng của runtime.

| | Claude | Codex |
|---|---|---|
| Config | `claude-settings.json` (`--settings`) | `codex-config.toml` + loạt `-c` |
| Hook | `hooks.SessionStart` / `hooks.Stop` | tương tự, qua `-c hooks.*` + `--enable hooks` |
| ACL | `permissions.{additionalDirectories,deny}` | `[sandbox_workspace_write]` + `[[rules]]` |
| Read-only | `sandbox.filesystem.denyWrite` + `--permission-mode plan` | `-s read-only` |
| Headless | — (main luôn interactive) | `exec --skip-git-repo-check` |

Env chung: `ALP_ROLE`, `ALP_DELEGATED_ROLE`, `ALP_DELEGATION_EXECUTION_ID`,
`ALP_DELEGATION_WORKSPACE`, `ALP_EXECUTION_ROOT`, `ALP_MEMORY_ROOT`, `ALP_IDENTITY_CAPSULE`,
`ALP_RUNTIME_CONFIG`, `ALP_SKILL_ROOTS`, và `ALP_READONLY_DIRS` khi read-only.

Prompt không nhúng capsule inline — nó trỏ agent tới `prompt.md` để tránh argv quá dài và để
hook có thể verify nội dung độc lập.

`RuntimeSelector` giải quyết runtime theo thứ tự: `explicit (--runtime)` → `interactive` (menu
↑/↓ trên TTY, ghi lại lựa chọn) → `persisted` (`~/.alp/runtime.json`) → `default` (claude).
Preference hỏng → warning + fallback claude, không throw.

### 4.7 `src/backend/` + `src/delegation/` — lifecycle

`ExecutionBackend` là contract 6 method: `healthCheck · spawn · status · wait · cancel · cleanup`.
`BackendExecutionStatus` chỉ có 5 giá trị: `queued | running | completed | failed | cancelled` —
mọi state riêng của Paseo phải được adapter map về đây.

`LocalProcessBackend` là implementation thuần TS: spawn child process, theo dõi `close`/`error`,
xoá temporary file khi settle.

`BackendRegistry` validate backend có đủ 6 method trước khi register — không có `if paseo /
else paseo` trong core.

`DelegationService` sở hữu:
- **Backend pinning**: backend được ghi vào execution record lúc spawn. `status/wait/cancel/
  cleanup` luôn resolve lại đúng backend đó, kể cả sau khi config mặc định đổi.
- **Fallback chỉ trước spawn**: nếu primary unhealthy và có `fallbackBackend`, thử fallback.
  Sau khi spawn đã được gọi thì không bao giờ fallback (tránh execution trùng).
- **Result reconciliation**: khi backend báo terminal, service đọc `state.json` — output đã
  validate của ALP thắng, backend result chỉ là fallback khi state không đọc được.

Store có hai bản: `InMemoryDelegationExecutionStore` (test) và `FileDelegationExecutionStore`
(atomic write, versioned document).

### 4.8 `hooks/` + `src/hooks/execution-bridge.ts` — enforcement tại runtime

Chỉ còn hai hook, và **không hook nào chặn tool call**. ACL đã chuyển sang khai báo trong
config của chính runtime (`src/runtime/permission-rules.ts`) — xem bảng ở §4.6.

**`session-boot.cjs`** (SessionStart) — nạp identity vào context trước turn đầu tiên. Nó đọc
đúng một file `.alp/agents/<role>.md` rồi ghi
`hookSpecificOutput.additionalContext`. Cố tình **không** `require()` gì từ `dist/`: đó là
lý do nó tồn tại. Trước đây identity đi qua `prompt.md` và agent phải tự Read file — tốn một
lượt gọi tool trước khi làm bất cứ việc gì. Hook này **fail-open**: lỗi thì session vẫn mở,
`additionalContext` rỗng và cảnh báo hiện ở `systemMessage`.

Tài liệu `.md` do `alp identity sync` sinh từ registry (`renderIdentityDocument`); registry
vẫn là nguồn sự thật duy nhất, file chỉ là cache phẳng cho tốc độ boot.

**`session-end.cjs`** (Stop) → `finalizeExecution()`: advance workflow tới output state rồi
`submitOutput`. Message cuối được ghi thẳng vào `state.json` dưới dạng text. Hook này **không
bao giờ** trả `decision: block` — phiên bản cũ parse JSON và block khi thất bại, đó chính là
cơ chế ép agent nói JSON.

**Đã mất khi bỏ `acl-guard.cjs`** (không có tương đương khai báo, ghi ở đây để đừng tưởng vẫn còn):

- `hasIndirectCommand` — chặn `$(...)`, backtick, `eval`, `bash -c`, `xargs`, `base64`.
- Tool gating theo workflow state (tool cho phép ở `EXECUTE` nhưng không ở `REPORT`).
- Trên **Codex**: sandbox chỉ chặn **ghi**, không chặn **đọc**. Cách ly private memory theo
  đường đọc chỉ còn ở mức instruction. Claude vẫn cưỡng chế được qua `deny Read(...)`.

`PolicyEngine` vẫn chạy đầy đủ lúc `prepare`; mất mát chỉ nằm ở lớp chặn từng tool call.

**Windows: không có sandbox, nên đổi tool grant chứ không đổi bất biến.** Claude Code không
kích hoạt filesystem sandbox trên Windows (báo feature gate off), mà ALP xin kèm
`failIfUnavailable` — kết quả là mọi delegated execution chết ngay lúc khởi động. Adapter nay
chỉ xin sandbox ở nơi cấp được. Bảo đảm read-only **không** bị bỏ theo: role read-only không
có grant `Write`/`Edit`, nên đường ghi duy nhất còn lại là shell, và `claudePermissions` rút
`Bash` khi không có sandbox. Specialist yếu đi; policy của nó không thành lời nói dối.

Hệ quả phụ: `.alp/agents/<role>.md` liệt kê grant trong registry, không phải grant đã điều
chỉnh theo nền tảng — trên Windows một role đọc thấy mình có `Bash` rồi bị deny khi dùng.
`deny` thắng nên an toàn, chỉ là agent phải chịu một lần từ chối để biết.

**Codex không nhận identity qua hook.** Cùng một `session-boot.cjs` chạy tốt trên Claude Code
lại bị Codex báo `SessionStart Failed`, và phiên không hề biết role của mình. Vì vậy prompt
của Codex mang thêm mục `## Identity` (`renderCapsulePrompt(capsule, { identityFromHook: false })`);
Claude Code vẫn đi đường hook, không trả tiền hai lần. Chưa rõ nguyên nhân phía Codex — gộp
lại một đường khi nào quan sát thấy Codex chấp nhận hook.

### 4.9 `src/cli/` — composition root

`parseAlpArgs` là hàm thuần, tách khỏi I/O — test parse không cần filesystem. Nó cũng chặn
tường minh các shortcut raw runtime (`alp claude`, `alp codex`, `alp run-role`, `--role`).

`defaultDependencies()` là nơi duy nhất wire các layer lại. `main()` nhận `injected?:
AlpDependencies` nên E2E test thay được toàn bộ dependency graph.

`ProjectRegistryStore` (`~/.alp/projects.json`) quyết định workspace mode: cwd đã đăng ký →
`workspace-write`, chưa → `read-only`. `alp init` **chỉ** ghi vào registry — không tạo
`.claude/`, `.codex/`, symlink skill hay config trong project, nên `git status` không đổi.
`alp deinit` gỡ registration và dọn artifact do bản ALP cũ để lại.

## 5. Ranh giới TypeScript / CommonJS

Repo có hai thế giới, cố ý:

| | `src/**.ts` → `dist/` | `scripts/**.cjs` |
|---|---|---|
| Chứa | policy, identity, memory, execution, runtime, delegation core | installer, doctor, update/uninstall, Paseo backend adapter, config loader |
| Vì sao | type safety, test được, là nguồn sự thật | phải chạy được *trước khi* build tồn tại, và trên máy chỉ có Node |

Cầu nối duy nhất là `createRequire` trong `cli/commands/delegate.ts`: TS load
`scripts/lib/delegation/{config,backends/*}.cjs`, bọc CJS backend bằng
`CjsExecutionBackendAdapter` để chúng thoả `ExecutionBackend`. Chiều ngược lại,
`hooks/*.cjs` require `dist/src/hooks/execution-bridge.js`.

`scripts/run-role.cjs` và `scripts/delegate.cjs` là compatibility wrapper vào cùng service —
không có logic policy riêng.

## 6. Trạng thái trên đĩa

```text
~/.alp/
  projects.json              danh sách project đã init + backend  (0600)
  runtime.json               runtime preference                    (0600)
  executions/<exec_id>/
    policy.json              ExecutionPolicy snapshot              (0600)
    state.json               StoredExecutionState                  (0600)
    runtime/                 capsule, prompt.md, config, skill-roots
  delegation/<repo-key>/
    code-native-executions.json
    paseo.json               state riêng của backend adapter
    execution-snapshots/

<repo>/memory/               không theo Git; scaffold từ scaffold/memory/
<repo>/dist/                 build output; doctor kiểm build-source drift
```

Mọi file state ghi bằng pattern **temp file → atomic rename → chmod**, và mọi directory tạo
với mode `0700`.

## 7. Mô hình mối đe doạ

| Đường tấn công | Phòng thủ |
|---|---|
| Agent tự leo quyền bằng cách sửa definition | Definition freeze; `configuration` request luôn deny; `definitionHash` trong policy |
| Dùng execution snapshot cũ/sửa tay | Bridge tính lại policy từ registry và so nguyên văn mỗi lần hook chạy |
| Gọi thẳng `herdr`/`paseo` để bypass policy | `invariants.ts` + `permissions.deny` (Claude) / `[[rules]] allow = false` (Codex) |
| Che lệnh bằng `eval`/`$()`/`base64` | `hasIndirectCommand` deny thay vì cố parse |
| Path escape qua symlink | `realpath` ở workspace policy, memory mapper và bridge |
| Đọc private memory của role khác | Chặn 2 lần: registry validate lúc load, memory policy lúc chạy |
| Ghi ngoài workspace trong lượt delegated | `WORKSPACE_SCOPE_MISMATCH` + hook kiểm từng path candidate |
| Ghi bằng Bash trong execution read-only | `isWriteCapableShell` |
| Trả output rác rồi coi như xong | Output contract + repair budget = 1, Stop hook fail-closed |

Giới hạn đã biết, ghi trong source: command inspection là guardrail chứ không phải isolation.
Code thù địch thật sự cần OS sandbox hoặc container.

## 8. Kiểm thử

```bash
npm run typecheck && npm run build && npm test
for f in scripts/test-*.cjs; do node "$f" || break; done
```

| Tầng | Ở đâu | Kiểm gì |
|---|---|---|
| Unit | `test/{agents,policy,memory,execution,workflow,runtime}` | invariant từng layer |
| Contract | `test/memory/memory-store.contract.ts` | `MarkdownFileStore` và `RemoteApiStore` cùng hành vi |
| Integration | `test/{delegation,backend,hooks,cli}` | ghép layer, deny ordering, hook enforcement |
| E2E | `test/e2e/` | 4 suite, dựng fake `claude`/`codex` binary — kiểm launch contract, delegation, memory isolation, runtime selection mà không tốn tiền model |
| Cutover | `test/cutover/no-legacy-identity.test.ts` | không còn identity Markdown sót lại |
| Cross-platform | 9 × `scripts/test-*.cjs` | CLI link, Codex role, backend, hook, installer Windows, update, uninstall |

`scripts/test-uninstall.cjs` có process-level fixture chứng minh CLI hoàn tất được ngay cả khi
nó vừa xoá chính thư mục chứa code của mình.

## 9. Mở rộng hệ thống

| Muốn thêm | Làm gì | Không được đụng |
|---|---|---|
| Agent mới | file trong `src/agents/`, thêm vào `AGENT_DEFINITIONS`, khai `reportsTo`/`delegatesTo` | policy engine |
| Backend mới | implement `ExecutionBackend`, register ở composition root | `delegation/core`, policy, memory |
| Runtime mới | implement `RuntimeAdapter`, thêm vào adapter map | execution, capsule |
| Memory backend mới | implement `MemoryStore` (hoặc `MemoryApiClient`), pass vào `MemoryService` | agent logic |
| Loại policy mới | thêm variant vào `AuthorizationRequest` + nhánh trong `PolicyEngine` | — |

Quy tắc chung: thêm implementation ở composition root, không thêm nhánh điều kiện vào core.

## 10. Vận hành

| Lệnh | Việc |
|---|---|
| `alp doctor [--quiet]` | `AGENT-REGISTRY`, `RUNTIME-CLAUDE/CODEX`, `MEMORY-ADAPTER`, `EXECUTION-STATE`, `ORPHAN-EXECUTION`, `BUILD-DRIFT`. Exit `0` healthy · `1` có finding · `2` doctor lỗi |
| `alp update` | fast-forward source, rebuild, giữ nguyên memory + runtime/backend preference |
| `alp uninstall [--purge-memory] [--force]` | gỡ CLI/state; mặc định backup memory |
| `alp delegation health [backend]` | health check backend |
| `alp delegation list` | execution record đang theo dõi |
| `scripts/bootstrap.cjs [--no-path]` | scaffold memory → `npm ci` → build → validate registry + adapter → doctor → link CLI |

## 11. Câu hỏi còn mở

- `DelegationService.prepare` gọi `void this.policy` / `void this.memory` — hai dependency này
  được inject nhưng chưa dùng trực tiếp (mọi authorization hiện đi qua `ExecutionService`).
  Nên bỏ khỏi constructor, hay giữ cho hướng mở rộng đã định trước?
- `alp delegate` và `alp` dùng hai `FileExecutionStore` root khác nhau
  (`~/.alp/executions` vs `<stateDir>/execution-snapshots`). Có chủ ý tách, hay nên hợp nhất
  để doctor và hook chỉ nhìn một nơi?
- `RemoteApiStore` đã có contract nhưng chưa có `MemoryApiClient` implementation nào ngoài fake
  trong test — server-backed memory đang ở lộ trình nào?
