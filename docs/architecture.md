# Kiến trúc alp-code

> Tài liệu kiến trúc hệ thống. Mô tả layer, contract giữa các layer, luồng dữ liệu và các
> ranh giới tin cậy. Cập nhật từ source tại `main` (2026-08-27).
>
> Doc này mô tả hệ thống **đang là**. Hướng đi và các nguyên tắc quyết định nằm ở
> [Triết lý thiết kế & Tầm nhìn](./alp-design-philosophy-and-vision.md).

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

Runtime (Claude/Codex) là **plugin thay được**, không phải nguồn sự thật của identity hay
quyền. Backend thì chỉ còn một: `LocalProcessBackend`.

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
│                  LocalProcessBackend + detached supervisor (TS)      │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│  hooks/          session-boot.cjs (SessionStart) · session-end (Stop) │
│                  compact-record.cjs (PreCompact/PostCompact, opt-in) │
│                  → src/hooks/execution-bridge.ts                     │
│                  enforce policy *bên trong* tiến trình runtime       │
└──────────────────────────────────────────────────────────────────────┘
```

Luật phụ thuộc: layer trên import layer dưới, không bao giờ ngược lại. `policy/` không biết
runtime; `agents/` không biết backend; `memory/` không biết execution.

## 3. Hai luồng chính

### 3.1 `alp` — phiên main tương tác

```text
alp [--mode low|medium|high|ultra|puck]
  → parseAlpArgs                       (cli/alp.ts; mode: cờ → ALP_MODE → DEFAULT_MODE)
  → ModeSelector.select                (explicit | interactive TTY | persisted | default)
  → runtimeForMode(main, mode)         (model của nấc quyết định CLI — không ai chọn runtime)
  → ProjectRegistryStore.isRegistered  → workspace-write nếu đã `alp init`, else read-only
  → ExecutionService.prepare           (parent = "principal", target = "main")
       ├─ assert main.reportsTo === "principal"
       ├─ PolicyEngine.authorize({ type: "workspace", ... })
       ├─ MemoryService.buildContext
       ├─ WorkflowRunner.initialize
       ├─ createExecutionPolicy   → snapshot (kèm `mode`) + definitionHash + policyHash
       ├─ createIdentityCapsule   → lọc memory theo grant, cắt tool theo workflow state
       └─ FileExecutionStore.create → ~/.alp/executions/<id>/{policy,state}.json  (0600)
  → RuntimeAdapter.probe               (binary có trên PATH không)
  → RuntimeAdapter.prepare             → RuntimeLaunchSpec; model/effort = modelForMode(main, mode)
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
       ├─ runtimeForMode(target, mode) (nấc → model → CLI; request không chọn runtime)
       ├─ adapter.prepare              → launch spec; model/effort = nấc (ALP_MODE) → definition
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
  reportsTo, delegatesTo, autoCompactTokens?: {claude?, codex?},
  capabilities: {tools, skills, subagents, mcpServers, memory, workspace},
  instructions: {role, purpose, rules, audience?}, workflow, output }
```

`defineAgent()` deep-clone rồi `Object.freeze` đệ quy — definition không thể bị mutate sau khi
load, kể cả bởi code trong cùng process.

`createAgentRegistry()` validate khi load, throw `AgentRegistryError` nếu:

| Kiểm tra | Mã lỗi |
|---|---|
| id trùng | `DUPLICATE_AGENT` |
| id/displayName/model/workflow rỗng, effort không hợp lệ | `INVALID_AGENT` |
| `autoCompactTokens[runtime]` không nguyên, ngoài 100k–1M, hoặc vượt cửa sổ của model runtime đó | `INVALID_AUTO_COMPACT_LIMIT` |
| tool ngoài `TOOL_CATALOG` | `UNKNOWN_TOOL` |
| workspace write root không nằm trong read root | `INVALID_WORKSPACE_GRANT` |
| memory write grant không được read grant bao phủ | `INVALID_MEMORY_GRANT` |
| `private:<other>` trong grant của agent khác | `INVALID_MEMORY_GRANT` |
| `reportsTo`/`delegatesTo` trỏ agent không tồn tại | `UNKNOWN_RELATION` |
| self-delegation hoặc chu trình delegation | `INVALID_DELEGATION` |

Registry là **DAG**, kiểm bằng DFS 3 màu (`assertNoDelegationCycles`).

Loadout hiện tại:

Model **không** còn nằm trong bảng này: nấc sở hữu ghế của cả chín vai (§ dưới). Cái definition
còn khai — `model: {claude, codex}` — chỉ là chỗ dựa cho vai không có trong loadout nào.

| Agent | Model / effort | Tools | Memory write | Workspace |
|---|---|---|---|---|
| `main` (Phở 🍜) | ghim | 7 (không Write/Edit) | shared, project:\*, private:main | read |
| `worker` (Worker 🛠️) | nấc | tất cả 9 | private:worker | read + write |
| `search` | nấc | Read Glob Grep Bash Skill | private:search | read |
| `librarian` | nấc | + WebSearch WebFetch | shared:reference:\*, project:\*:refs:\*, private | read |
| `read-thread` | nấc | Read Glob Grep Skill | private:read-thread | — |
| `review` | nấc | Read Glob Grep Bash Skill | private:review | read |
| `oracle` | nấc | + WebSearch WebFetch | private:oracle | read |
| `compaction` | nấc | Read Glob Grep | private:compaction | — |
| `titling` | nấc | — | private:titling | — |

Chỉ `main` có `delegatesTo` khác rỗng. Cây delegation phẳng: `principal → main → {8 specialist}`.

Từ 2026-09-10 `main` **thôi cầm bút**: không `Write`, không `Edit`, `writeRoots: []`. Lý do là
một ranh giới chứ không phải một mức quyền — ghế duy nhất nói chuyện với principal cũng là ghế
duy nhất giữ toàn cảnh, và khi nó vừa giữ toàn cảnh vừa tự sửa file thì mọi việc "nhỏ đủ để tự
làm" đều ở lại đó: không nhát cắt, không báo cáo, không bằng chứng ai đọc lại được. Bỏ hẳn bút
thì câu hỏi "nhỏ đủ chưa" biến mất.

`worker` là hệ quả: vai **generic** duy nhất ngoài `main`, và là vai duy nhất khai write root.
Bảy vai kia hẹp theo *loại việc* (retrieval, research, review, second opinion); `worker` hẹp
theo **phạm vi một lần giao**. `delegatesTo` của nó rỗng — nếu nó phải đi hỏi `search` giữa
chừng thì cái sai nằm ở nhát cắt của `main`, không ở quyền của nó.

Quyền ghi workspace đi theo **vai đích**, không theo ai gọi: `runDelegateCommand` xin
`workspace-write` khi và chỉ khi definition của target khai write root, và `runMainSession` hạ
phiên `main` xuống `read-only` kể cả trong project đã đăng ký — project đăng ký là *trần*, không
phải một cái cấp phát.

#### Dial công suất — `low` · `medium` · `high` · `ultra`, cộng `puck`

`modes.ts` giữ dial. Người dùng không phải nhớ model nào giỏi việc gì; câu hỏi duy nhất là
**"việc này khó cỡ nào"**. Nấc trả lời bằng một **loadout hoàn chỉnh**: mỗi vai đúng **một**
model và một mức suy nghĩ.

Một model cho mỗi vai kéo theo hệ quả lớn nhất của thiết kế này: **model quyết định runtime**.
`claude-*` phóng Claude Code, `gpt-*` phóng Codex CLI, tra qua bảng `MODEL_RUNTIMES` viết tay
trong `model-context.ts` (không đoán theo prefix — một tên lệch quy ước mà đoán sai thì phóng
nhầm CLI trong im lặng). Không còn bước "chọn runtime rồi tra model": nấc là lựa chọn duy
nhất, và một nấc trộn được hai CLI trong cùng một phiên — `medium` chạy `worker` trên Codex và
`oracle` trên Claude.

Bốn nấc dial xoay hai ghế mà độ khó chạm tới — `worker` (người cầm bút) và `oracle` (người được
hỏi khi bí):

| Nấc | `worker` | effort | `oracle` | effort |
|---|---|---|---|---|
| `low` | claude-sonnet-5 | high | gpt-5.6-sol | high |
| `medium` (mặc định) | gpt-5.6-sol | high | claude-opus-5 | high |
| `high` | claude-opus-5 | high | gpt-5.6-sol | xhigh |
| `ultra` | claude-opus-5 | high | gpt-6-astra | high |
| `puck` | gpt-5.6-sol | xhigh | gpt-5.6-sol | xhigh |

Bảy vai còn lại giữ nguyên qua cả bốn nấc dial — đúng chỗ Amp ghim cứng subagent — vì model
của chúng là **một phần công việc** (`search` cần retrieval nhanh, `titling` viết một dòng)
chứ không phải một mức cố gắng. `main` nằm trong nhóm đó từ 2026-09-10, khi nó thôi cầm bút:
nghe principal, nghĩ cùng họ, cắt việc ra — không việc nào trong ba việc đó dễ đi hơn khi bài
toán dễ đi, và nó là mặt tiền của cả phiên; nên nó đứng yên ở Opus 5 · high, còn độ khó được
trả lời ở chỗ nó thật sự được trả lời: ghế làm việc. `oracle` luôn đứng ở runtime **đối diện**
`worker`: người được hỏi khi bí phải là một cách nhìn khác, không phải cùng model tự hỏi lại
chính nó. `high` và `ultra` cùng cầm bút bằng Opus 5 — khác nhau ở oracle, nơi `ultra` leo lên
model mới nhất (Astra) thay vì chỉ cộng thêm effort.

| Vai | `low`/`medium`/`high`/`ultra` | `puck` |
|---|---|---|
| `main` | claude-opus-5 · high | gpt-5.6-sol · xhigh |
| `search` | gpt-5.6-terra · low | gpt-5.6-terra · low |
| `librarian` | gpt-5.6-sol · high | gpt-5.6-sol · high |
| `read-thread` | claude-haiku-4-5 · low | gpt-5.6-luna · low |
| `review` | claude-opus-5 · high | gpt-5.6-terra · medium |
| `compaction` | claude-opus-5 · medium | gpt-5.6-sol · medium |
| `titling` | claude-haiku-4-5 · low | gpt-5.6-luna · low |

`puck` nằm **ngoài** trục độ khó: nó là câu trả lời cho "chạy toàn Codex" — máy chỉ cài
`codex`, hạn mức Claude đã hết, hoặc muốn đúng loadout Amp mặc định. Đây là nấc duy nhất
không có Claude ở bất kỳ vai nào.

Chọn nấc: `alp --mode <nấc>` → `ALP_MODE` → `alp mode set` (`~/.alp/mode.json`) → menu ↑/↓ trên
TTY → `DEFAULT_MODE` (`medium`). Nấc gõ sai dừng ngay chứ không rơi về mặc định. Nấc đi vào
`ExecutionPolicy.mode`, và **loadout đã chốt** đi cùng nó: `model`, `reasoningEffort`, `runtime`
cũng nằm trong `policy.json` và trong `policyHash` — từ khi settings sửa được nội dung một nấc,
tên nấc một mình không còn trả lời nổi "lần chạy này chạy gì", nên hai lần chạy khác model
không thể có cùng hash dù cùng tên nấc; `definitionHash` **không** đổi theo nấc, vì nấc là lựa chọn lúc
phóng chứ không phải một vai khác. Adapter export `ALP_MODE`, nên execution delegated kế thừa
nấc của phiên cha. Mọi model trong loadout phải có mặt trong cả `MODEL_RUNTIMES` lẫn
`MODEL_CONTEXT_WINDOWS` (test giữ): thiếu bảng đầu thì không biết phóng CLI nào, thiếu bảng sau
thì ngưỡng compact mặc định biến mất đúng ở nấc đó.

#### Loadout sửa được — `settings.json` (2026-09-10)

Bảng trên là bản **built-in**, không phải bản đang chạy. Một máy hoặc một project ghi đè được
model và mức nghĩ của từng vai ở từng nấc, qua ba file đọc theo thứ tự thắng dần:

| File | Của ai | Commit? |
|---|---|---|
| `~/.alp/settings.json` | máy — hạn mức, CLI đã cài, sở thích một người | không |
| `<project>/.alp/settings.json` | project, đi cùng repo | có |
| `<project>/.alp/settings.local.json` | người này trên project này | không |

Đúng ba tầng Claude Code đã dạy người dùng, đặt trong `.alp/` mà `alp init` đã tạo — không có
chỗ mới nào phải học. Gốc project tìm bằng cách đi ngược lên tới thư mục cha gần nhất có
`.alp/`, nên gõ `alp` từ thư mục con vẫn đúng file.

```json
{
  "modes": {
    "*":    { "titling": { "model": "gpt-5.6-luna" } },
    "high": { "worker": { "model": "claude-opus-5", "reasoningEffort": "max" } }
  }
}
```

`"*"` áp cho mọi nấc và **thua** nấc gọi đích danh; giữa các file thì file sau đè file trước.
Khai một nửa thì nửa kia mượn từ built-in — sửa mức nghĩ không bắt chép lại tên model. Vai
**chưa có ghế** trong loadout nào (custom agent) không có nửa nào để mượn, nên phải khai đủ
hai trường.

Fail-closed, và luôn nói tên file: nấc lạ, khoá lạ **bên trong** một override, model không có
trong `MODEL_RUNTIMES`, effort không có trong `REASONING_EFFORTS`, hoặc override rỗng — tất cả
đều dừng phiên. Khoá gốc ngoài `modes` thì bỏ qua, vì ALP không phải chủ duy nhất của
`settings.json`. Một dòng sai bị lờ đi trong im lặng nghĩa là chạy khác loadout người ta viết
ra, và đó là thứ tệ hơn một lỗi.

Giới hạn cố ý: file này ghim **model và effort**, không hơn. Không có đường nào từ đây đi tới
tool, memory, workspace hay `delegatesTo` — quyền vẫn chỉ ở registry code-native, nơi review
được qua PR.

`src/agents/mode-settings.ts` thuần (parse + merge, không I/O); `src/cli/settings.ts` biết ba
đường dẫn và đọc đĩa. Bản đã ghép đi vào tham số `profiles` của `modelForMode` /
`reasoningEffortForMode` / `runtimeForMode` / `homeRuntimeForMode` — mặc định là built-in, nên
chỗ nào chưa nạp settings vẫn chạy y như trước. `alp mode show` in thêm `SETTINGS <file>` và
một dòng `OVERRIDE` cho mỗi ghế đã dịch (dòng đầu vẫn chỉ là tên nấc, để script cũ không gãy).

**`--runtime` đã bị bỏ** (2026-09-04). Runtime là hệ quả của model, không phải một lựa chọn
song song — giữ cả hai thì một `--runtime claude` cộng nấc `medium` sẽ hỏi Claude Code chạy
`gpt-5.6-sol`. `alp --runtime`, `alp runtime show|set` và `alp delegate --runtime` đều **dừng
với lỗi chỉ sang nấc**, chứ không bị bỏ qua trong im lặng.

`model-context.ts` giữ `MODEL_CONTEXT_WINDOWS` — cửa sổ context của từng model. Ngưỡng compact
khai **theo runtime** vì nó là ngân sách của model chứ không của vai một mình: cùng một
500 000 là "nén sớm" trên cửa sổ 1M và là một dòng không bao giờ chạm tới trên cửa sổ 272k.
Adapter lấy `policy.autoCompactTokens[runtime] ?? defaultAutoCompactTokens(model)`, tức 90%
cửa sổ khi vai bỏ trống phía đó. Registry chặn ngưỡng vượt cửa sổ ngay lúc load. Model không
có trong bảng thì không có mặc định và adapter bỏ hẳn khoá đó, để runtime giữ cửa sổ của nó.
Test giữ bảng phủ hết model chín vai built-in route tới.

Ngân sách chín vai (— là bỏ trống, tức 90% cửa sổ):

| Vai | claude | codex | Thực nén ở (claude / codex) |
|---|---:|---:|---|
| `main` · `worker` · `oracle` | — | — | 900 000 / 244 800 |
| `librarian` · `review` | 300 000 | — | 300 000 / 244 800 |
| `read-thread` | — | 200 000 | 180 000 / 200 000 |
| `search` · `compaction` | 150 000 | 150 000 | 150 000 / 150 000 |
| `titling` | 100 000 | 100 000 | 100 000 / 100 000 |

`shared/` chứa phần dùng chung: `house-rules.ts` (`CODE_NATIVE_HOUSE_RULES` — 4 quy tắc
code-native cho mọi vai; `CODE_CRAFT_RULES` — 4 quy tắc tay nghề chỉ spread vào `main`,
`worker`, `review`, `oracle` là các vai viết, chỉ đạo hoặc phán xét code), `voice.ts` (`renderInstructions` —
khuôn prompt thống nhất), `principal.ts` (một dòng "phục vụ ai, xưng hô thế nào").

`principal.ts` **không** chứa tên ai cả: nó đọc `~/.alp/principal.json` qua
`src/principal/principal-profile-store.ts`. `alp init` hỏi ba câu (tên, agent gọi principal
là gì, agent tự xưng là gì) lần đầu trên TTY và ghi profile 0600; không có profile thì mọi
vai nhận bản trung tính `Serve the principal.` — không chặn phiên, không đoán tên. Đọc bằng
`readFileSync` vì `renderInstructions(spec)` là hàm sync và được gọi ở đúng hai chỗ:
`renderIdentityDocument` (lúc `alp init`/`identity sync`) và `createIdentityCapsule`.

Từ 2026-09-10, `instructions` trên definition là **dữ liệu** (`InstructionSpec`: `role`,
`purpose`, `rules[]`, `audience?`) chứ không còn là closure. Lý do nằm ở hash — xem §4.4.

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
- `definitionHash` = SHA-256 của definition đã canonicalize. `instructions` là dữ liệu nên
  vào hash theo đúng nội dung; hàm còn lại (`validate`) vẫn vào hash bằng *source của hàm*.
  Điều này quan trọng cho §5.6: khi loader dựng custom agent từ `agent.yaml`, mọi agent sẽ
  dùng **chung một** closure render — nếu identity còn là hàm thì hai agent có prompt hoàn
  toàn khác nhau vẫn hash giống hệt, và một hash principal đã trust sẽ nghiệm đúng cho một
  prompt khác. Đã kiểm chứng trên code trước bản sửa.
- `policyHash` = SHA-256 của chính snapshot.

**`IdentityCapsule`** — bundle gửi cho runtime: instructions đã render, task, workspace,
memory đã lọc, workflow state, `allowedTools` = giao của capability grant và tool cho phép ở
state hiện tại, JSON Schema của output contract.

**`StoredExecutionState`** — trạng thái tiến triển, ghi vào `state.json`.

`FileExecutionStore` ghi qua staging directory + atomic `rename`, mode `0700`/`0600`, và từ
chối nếu execution ID đã tồn tại hoặc chứa separator.

### 4.5 `src/workflow/` — state machine + output contract

Mỗi agent có một workflow tuyến tính (`defineLinearWorkflow`) với tool set thu hẹp dần theo
state. Ví dụ `main`: `ASSESS` (chỉ đọc) → `PLAN` (đọc + web + Skill) → `DELEGATE` (thêm Bash)
→ `VERIFY` (đọc + Bash) → `REPORT` (không tool). Còn `worker`: `ASSESS` → `IMPLEMENT` (đủ 9
tool) → `VERIFY` → `REPORT`.

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
`identity-capsule.json`, `session-context.md`, `skill-roots.json`, file config riêng của runtime,
và `task.md` **chỉ khi headless**.

**Hai kênh, không phải một blob.** `session-context.md` (`renderSessionContext`) mô tả agent cho cả
phiên — identity, authority, invariants, policy, reporting contract — và **không bao giờ tạo turn**.
`task.md` (`renderTaskInput`) mang memory đã chọn cùng task, và **chính là** turn đầu tiên. Vì vậy
phiên interactive không sinh `task.md`: không có gì để adapter lỡ tay đưa thành positional prompt.

| | Claude | Codex |
|---|---|---|
| Config | `claude-settings.json` (`--settings`) | `codex-config.toml` + loạt `-c` |
| Hook | `hooks.SessionStart` / `hooks.Stop` | tương tự, qua `-c hooks.*` + `--enable hooks` |
| ACL | `permissions.{additionalDirectories,allow,deny}` | `[sandbox_workspace_write]` + `[[rules]]` |
| Skill/subagent/MCP grant | `allow: Skill(<tên>)`, `Agent(<tên>)`, `mcp__<server>`; `--mcp-config` + `--strict-mcp-config`; `--agents <json>` | `-c mcp_servers.<tên>={…}`; không có subagent in-process |
| Read-only | `sandbox.filesystem.denyWrite` + `--permission-mode plan` | `-s read-only` |
| Tool grant | mọi tool ngoài grant vào `permissions.deny` theo tên — runtime từ chối lúc gọi | **không cưỡng chế được**: shell của Codex là built-in, `--sandbox` chỉ chọn lệnh đụng được gì |
| Read root | `additionalDirectories` — đọc ngoài đó bị từ chối | **không cưỡng chế được**: sandbox read-only cho đọc mọi path |
| Ghi / egress mạng | `denyWrite` + không có tool mạng | sandbox từ chối cả hai ✓ |
| Interactive | `--dangerously-skip-permissions` · **không positional prompt** | `--dangerously-bypass-approvals-and-sandbox` · **không positional prompt** |
| Headless | positional trỏ tới `task.md` | `exec --skip-git-repo-check` + positional trỏ tới `task.md` |

Ba dòng cuối bảng đo được ngày 2026-09-10, không phải suy từ tài liệu: một vai chỉ có
`Read, Glob, Grep, Skill` đã chạy `/bin/zsh -lc "… node -e …"` trên Codex và thành công (log
`exec_42c6500fcbe74dfea28b`), còn `codex sandbox -c sandbox_mode='"read-only"' -- cat <path ngoài
workspace>` in ra nội dung file. Cùng phép đo cho thấy ghi bị `Operation not permitted` và `curl`
không nối được mạng. Nghĩa là **trên Codex, `Bash` và `workspace.readRoots` là ràng buộc mức
prompt**; ghi và egress thì sandbox giữ thật. `enforcementNotes` trong `permission-rules.ts` in
đúng điều này ra trong bảng của `alp agent test` và `alp agent add`, để principal duyệt trust
không đọc bảng Authority như một lời hứa mà nó chỉ giữ được một nửa.

**Phiên interactive chạy không guardrail, và đó là quyết định có ý thức.** `alp` (`run-main`) là
phiên duy nhất đặt `interactive: true`; `alp delegate` luôn `false`. Principal ngồi ngay đó và tự
duyệt được từng bước, nên prompt quyền chỉ là ma sát. Cái đánh đổi phải nói thẳng: cờ bypass vô hiệu
hoá `permissions.deny` (Claude) và sandbox (Codex) **cho riêng phiên đó** — gồm cả cách ly private
memory giữa các role. Nó không phải công tắc toàn cục: settings/config sinh cho mỗi delegated
execution vẫn mang đủ deny list và sandbox như cũ. Ở Codex, `-s` bị bỏ hẳn khi bypass thay vì để
lẫn — Codex nhận cả hai mà không báo lỗi (chỉ `--approve-for-me` khai `conflicts_with`), cờ bypass
thắng, nên giữ `-s` chỉ để lại một tham số nói sai về chế độ đang chạy.

Env chung: `ALP_ROLE`, `ALP_DELEGATED_ROLE`, `ALP_DELEGATION_EXECUTION_ID`,
`ALP_DELEGATION_WORKSPACE`, `ALP_EXECUTION_ROOT`, `ALP_MEMORY_ROOT`, `ALP_IDENTITY_CAPSULE`,
`ALP_SESSION_CONTEXT`, `ALP_RUNTIME_CONFIG`, `ALP_SKILL_ROOTS`, `ALP_POLICY_HASH`,
`ALP_CONTINUITY_CONTEXT`, `ALP_COMPACT_EVENTS`, và `ALP_READONLY_DIRS` khi read-only. Ba biến
cuối phục vụ compact bridge (§4.10) — luôn có mặt, không gated bởi flag nào.

Positional prompt không nhúng task inline — nó trỏ agent tới `task.md` để tránh argv quá dài và để
hook có thể verify nội dung độc lập.

`ModeSelector` giải quyết **nấc** theo thứ tự: `explicit (--mode)` → `interactive` (menu ↑/↓
trên TTY, ghi lại lựa chọn) → `persisted` (`~/.alp/mode.json`, ghi bằng `alp mode set`) →
`default` (`medium`). Preference hỏng → warning + fallback `medium`, không throw. Runtime
không có mặt trong chuỗi này ở đâu cả — nó rơi ra từ model của nấc.

### 4.7 `src/backend/` + `src/delegation/` — lifecycle

`ExecutionBackend` là contract 6 method: `healthCheck · spawn · status · wait · cancel · cleanup`.
`BackendExecutionStatus` chỉ có 5 giá trị: `queued | running | completed | failed | cancelled` —
mọi state của process phải map về đây.

`LocalProcessBackend` là implementation duy nhất, thuần TS: spawn child process, theo dõi
`close`/`error`, xoá temporary file khi settle. Background thì giao cho
`local-supervisor.ts` chạy detached, nên execution sống lâu hơn tiến trình `alp` và state
trong `<state_dir>/local.json` đọc được từ một CLI process khác.

Interface vẫn còn vì test cần thay bằng fake. Nó không còn là điểm mở rộng: không có
registry, không có `--backend`, không có fallback (2026-09-03).

`DelegationService` sở hữu:
- **Execution tracking**: mỗi execution được ghi vào `code-native-executions.json` lúc spawn,
  để `status/wait/cancel/cleanup` từ một CLI process sau vẫn tìm lại được.
- **Không retry sau spawn**: spawn hỏng nửa chừng được ghi `failed`, không thử lại (tránh
  execution trùng).
- **Result reconciliation**: khi backend báo terminal, service đọc `state.json` — output đã
  validate của ALP thắng, backend result chỉ là fallback khi state không đọc được.

Store có hai bản: `InMemoryDelegationExecutionStore` (test) và `FileDelegationExecutionStore`
(atomic write, versioned document).

### 4.8 `alp hook` + `src/hooks/execution-bridge.ts` — enforcement tại runtime

Chỉ còn hai hook, và **không hook nào chặn tool call**. ACL đã chuyển sang khai báo trong
config của chính runtime (`src/runtime/permission-rules.ts`) — xem bảng ở §4.6.

**`alp hook session-boot`** (SessionStart) — kênh **duy nhất** đưa session context vào view của model,
cho cả hai runtime. Đọc theo thứ tự ưu tiên:

1. `ALP_SESSION_CONTEXT` — `session-context.md` của chính execution này, do adapter ghi. Mọi phiên
   khởi chạy qua `alp` đều có, và chỉ nó mang invariants, policy context và workspace grant.
2. `.alp/agents/<role>.md` — tài liệu role tĩnh, cho đường native khi principal gõ thẳng
   `claude`/`codex` và không adapter nào tham gia.

Rồi ghi `hookSpecificOutput.additionalContext`. Lightweight entry rẽ nhánh trước
`defaultDependencies()` và execution bridge chỉ dynamic-import cho `session-end`; SessionStart
không evaluate registry/memory. Legacy `.cjs` còn nằm trong archive v0.10 chỉ cho compatibility.

Hook **fail-open**: lỗi thì session vẫn mở, `additionalContext` rỗng và cảnh báo hiện ở
`systemMessage`. Managed launch fail-closed ở tầng khác và sớm hơn — adapter ghi file *trước* khi
spawn, nên file không ghi được là `prepare()` throw và không tiến trình nào khởi động.

Tài liệu `.md` do `alp identity sync` sinh từ registry (`renderIdentityDocument`); registry
vẫn là nguồn sự thật duy nhất, file chỉ là cache phẳng cho tốc độ boot.

Từ 2026-09, `session-boot.cjs` ghép thêm một nguồn thứ hai vào cùng `additionalContext`:
`ALP_CONTINUITY_CONTEXT` (`continuity.md`, xem §4.10). Continuity là best-effort — thiếu hoặc
rỗng thì bỏ qua không cảnh báo (trạng thái bình thường của một execution chưa có pin nào),
oversize hoặc không đọc được thì bỏ qua kèm cảnh báo. Chạy giống hệt cho mọi `source`, gồm cả
`"compact"` — đây chính là điểm reinject sau native compaction.

**`session-end.cjs`** (Stop) → `finalizeExecution()`: advance workflow tới output state rồi
`submitOutput`. Message cuối được ghi thẳng vào `state.json` dưới dạng text. Hook này **không
bao giờ** trả `decision: block` — phiên bản cũ parse JSON và block khi thất bại, đó chính là
cơ chế ép agent nói JSON.

**Đã mất khi bỏ `acl-guard.cjs`** (không có tương đương khai báo, ghi ở đây để đừng tưởng vẫn còn):

- `hasIndirectCommand` — chặn `$(...)`, backtick, `eval`, `bash -c`, `xargs`, `base64`.
- Tool gating theo workflow state (tool cho phép ở `IMPLEMENT` nhưng không ở `REPORT`).
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

**Codex nhận identity qua hook, giống Claude.** Đo trên `codex-cli 0.149.0`: hook `SessionStart`
chạy đúng một lần và `additionalContext` vào transcript thành message `role: developer`, **trước**
user turn. Ghi nhận cũ "Codex báo `SessionStart Failed`" đã lỗi thời; hai runtime nay dùng chung
một đường, và identity không được đi hai kênh cùng lúc — nếu không sẽ vào context hai lần.

Cách đo lại khi Codex đổi hành vi: `codex debug prompt-input` in đúng danh sách message model nhìn
thấy mà không tốn model call, và một positional PROMPT hiện ra thành message `role: user` — đó là
turn giả mà phiên interactive phải không có.

### 4.9 `src/cli/` — composition root

`parseAlpArgs` là hàm thuần, tách khỏi I/O — test parse không cần filesystem. Nó cũng chặn
tường minh các shortcut raw runtime (`alp claude`, `alp codex`, `alp run-role`, `--role`).

`defaultDependencies()` là nơi duy nhất wire các layer lại. `main()` nhận `injected?:
AlpDependencies` nên E2E test thay được toàn bộ dependency graph.

`ProjectRegistryStore` (`~/.alp/projects.json`) quyết định workspace mode: cwd đã đăng ký →
`workspace-write`, chưa → `read-only`. `alp init` **chỉ** ghi vào registry — không tạo
`.claude/`, `.codex/`, symlink skill hay config trong project, nên `git status` không đổi.
`alp deinit` gỡ registration và dọn artifact do bản ALP cũ để lại.

### 4.10 `src/context/` — cross-runtime compact bridge

Claude Code và Codex CLI tự compact transcript của chính chúng; ALP không sửa, không đọc lại
native summary. Thay vào đó ALP giữ một **checkpoint** nhỏ bên ngoài transcript — objective và
các pin principal/agent tự chốt — và trả nó lại sau mỗi lần compact qua đúng một kênh:
`SessionStart`, cho mọi `source` kể cả `"compact"`. Không synthetic user turn, không
`PostCompact` (đo được là không runtime nào nhận `additionalContext` ở đó).

**Storage**, dưới `context/` cạnh `runtime/` (§6) — sống sót cleanup của `runtime/` vì là thư
mục anh em, không con:

| File | Ghi bởi | Nội dung |
|---|---|---|
| `checkpoint.json` | `ExecutionService.prepare()` (seed) · `alp context pin\|unpin` | objective + 4 loại pin, hash toàn vẹn |
| `continuity.md` | cùng hai nơi trên | render Markdown bounded 24 KiB, đây cũng là injection limit |
| `compact-events.jsonl` | chỉ `hooks/compact-record.cjs` | envelope thô-đã-lọc, một dòng mỗi `PreCompact`/`PostCompact` |

`checkpoint.json` seed ngay lúc `prepare()` với `objective = capsule.task` — execution đầu tiên
đã có nội dung thật để reinject, không cần đợi ai gõ lệnh. Task interactive là một sentinel
string (`INTERACTIVE_TASK_SENTINEL`, xuất từ `continuity.ts`); renderer bỏ qua đúng chuỗi đó.

**Producer** — hai nguồn, không tốn model call: `alp context pin <kind> -- <text>` từ CLI, và
một mục `## Continuity` trong session context (`continuitySection()` trong
`render-session-context.ts`) dạy agent lệnh đó — gate theo đúng session-wide `Bash` grant như
`## Delegation`, nên role read-only không thấy hướng dẫn nó không dùng được.

**Hook** — `hooks/compact-record.cjs`, zero-dependency, ~90 dòng: đọc stdin (hard-stop 1 MiB),
lọc theo whitelist per-runtime (`compact-payload.ts`), `appendFileSync` một dòng, exit 0 stdout
rỗng luôn luôn. Không đọc journal, không đụng `checkpoint.json`/`continuity.md`, không thể làm
hỏng dữ liệu cũ dù bị kill giữa chừng — một `O_APPEND` write dưới 16 KiB là atomic. `compact_summary`
(Claude, đo được 22–32 KB) nằm ngoài whitelist tuyệt đối; đây là lý do chính của giới hạn đó,
không chỉ để sạch sẽ.

**State** dẫn xuất, không phải file: `CompactEventV1`/`CompactionStateV1` tính bằng hàm thuần
(`compact-journal.ts`) mỗi khi `alp context status|validate` chạy. `generation` = số `completed`
đã dedupe theo `dedupeKey = runtime|sessionId|eventId|phase`; một `started` chưa khớp
`completed` là `pending` — trạng thái bình thường, không phải lỗi (đo được: Claude reinject
*trong khi* compact đang chạy, nên `pending` xuất hiện một nhịp là đúng).

**Capability đo được** (2026-09-03/04, xem plan gate CB-0), pin tĩnh trên từng adapter:

| Runtime | Version | PreCompact | PostCompact | SessionStart(compact) |
|---|---|---|---|---|
| Claude | 2.1.259 (2.1.240 đo TTY) | có | có | có — **trong** lúc compact |
| Codex | 0.153.0 | có | có | có — ở **đầu lượt sau** |

Cả hai đã đo trong inherited-TTY lẫn headless, trên darwin và win32; runbook chạy lại nằm trong
plan tại `plans/260903-2040-cross-runtime-compact-bridge/plan.md` §Gate CB-0. Runtime nào tương
lai không phát `SessionStart` sau compact thì `alp context status` báo `restore: next-session`
(persist-only) một cách trung thực, không giả vờ đã reinject.

**Flag**: `ALP_COMPACT_BRIDGE=1` bật đăng ký `PreCompact`/`PostCompact` trên cả hai adapter
(`compactBridgeEnabled()` trong `adapter-files.ts`). Rollback là bỏ biến môi trường; mọi thứ
khác — checkpoint, continuity, journal — không phụ thuộc flag này.

**CLI** (`src/cli/commands/context.ts`):

```text
alp context status [execution-id]      objective, số pin, generation, pending/last-completed, restore mode
alp context validate [execution-id]    checkpoint schema+digest+binding, journal parse+replay ổn định
alp context pin <decision|constraint|open-item|next-action> -- <text>
alp context unpin <pin-id>
```

Execution ID: positional trước (status/validate), rồi `ALP_DELEGATION_EXECUTION_ID`; `pin`/`unpin`
chỉ nhận từ env — dùng để một agent tự pin trong chính phiên nó đang chạy. Pin bị enforce 4 KiB,
control character bị strip, `source` = `agent` khi có `ALP_DELEGATED_ROLE` else `principal`.

**Riêng tư**: đừng pin secret hay nội dung file — pin sống trong `context/`, đọc lại được bằng
`cat`, và reinject thẳng vào context window của model. `context/` mode `0700`, file `0600`.

**Chạy live probe** (đo capability thật trên máy, không chạy trong CI):

```bash
node scripts/probe-compact-hooks.cjs --runtime claude --output ~/alp-probe/claude
node scripts/probe-compact-hooks.cjs --runtime codex  --output ~/alp-probe/codex
```

## 5. Ranh giới runtime / release tooling

Toàn bộ runtime closure — config, state, doctor, update/uninstall, hooks, policy, execution và
backend — nằm trong TypeScript được Bun compile thành executable. Không còn `createRequire`
động từ binary sang `scripts/`. `src/cli/entry.ts` route `--version`, `hook` và `__internal`
trước full CLI; `session-boot` không evaluate registry/memory/execution bridge.

CommonJS chỉ còn ở build/release tooling, dev compatibility wrappers và npm wrapper (npm user
đã có Node). Legacy `hooks/*.cjs` vẫn được mang trong v0.10 để migration có một chu kỳ lùi,
nhưng adapter mới ghi public contract `alp hook …`.

## 6. Trạng thái trên đĩa

Từ v0.9.0 có đúng hai loại thư mục, và ranh giới giữa chúng là ranh giới quan trọng nhất của
phần vận hành: **thư mục cài là artifact thay được**, **`~/.alp` là dữ liệu người dùng**. Máy
người dùng không build gì, nên update = thay nguyên khối thư mục cài. Bất cứ thứ gì của người
dùng còn nằm trong đó đều là dữ liệu hẹn ngày mất.

```text
~/.alp/                        DỮ LIỆU — không bao giờ bị update đụng vào
  install.json               bản cài hiện hành: root, channel, version   (0600)
  projects.json              danh sách project đã init + backend         (0600)
  mode.json                  nấc đã ghi nhớ                              (0600)
  settings.json              ghi đè loadout ở mức MÁY — người dùng tự viết
  principal.json             tên + xưng hô của principal                 (0600)
  update-check.json          cache kiểm bản mới, TTL 24h                 (0600)
  memory/                    scaffold từ `scaffold/memory/`, không theo Git
  agents/<role>.md           cache identity phẳng cho SessionStart hook
  hooks/<tên>.cjs            forwarder có đường dẫn ỔN ĐỊNH → hook của bản cài
  executions/<exec_id>/
    policy.json                ExecutionPolicy snapshot                  (0600)
    state.json                 StoredExecutionState                      (0600)
    runtime/                   capsule, session-context.md, config, skill-roots
                               + task.md chỉ khi headless
    context/                   sống sót cleanup của runtime/             (0700)
      checkpoint.json            objective + pin, hash toàn vẹn          (0600)
      continuity.md              render Markdown, bounded 24 KiB         (0600)
      compact-events.jsonl       journal append-only, hook ghi           (0600)
  delegation/<key>/          `installed` cho bản cài, hash repo cho dev clone
    code-native-executions.json  execution record của DelegationService
    local.json                   state riêng của backend (pid, log, result)
    logs/ · results/ · specs/    transcript, exit status và spec cho supervisor
    execution-snapshots/

~/.alp-code/                   BINARY INSTALL — versioned, thay được
  versions/vX.Y.Z/
    bin/alp                    native executable (`alp.exe` trên Windows)
    install-manifest.json
    skills/ scaffold/ hooks/ LICENSE
  current -> versions/vX.Y.Z
  bin/alp -> ../current/bin/alp       (POSIX stable command)

~/.alp-code/npm/              npm-wrapper payload cache, versioned theo package
  versions/X.Y.Z/<target>/    cùng artifact contract ở trên
```

Trong project, `alp init` đã tạo `.alp/`; hai file settings sống ở đó:

```text
<project>/.alp/
  settings.json              ghi đè loadout của PROJECT — commit được
  settings.local.json        ghi đè của riêng người này — không commit
  agents/ · skills/          agent và skill của project
```

Cả ba file settings đều do người dùng viết tay, đều tuỳ chọn, và đều không bị lệnh nào của ALP
ghi đè.

Mọi file state ghi bằng pattern **temp file → atomic rename → chmod**, và mọi directory tạo
với mode `0700`.

### 6.1 Ba channel cài

`InstallLayout` là boundary duy nhất cho path runtime: channel, build-time version,
selfExecutable, stableCommand, installRoot và assetRoot. npm wrapper truyền metadata explicit;
native code kiểm executable nằm trong payload và wrapper/payload cùng version.

| Channel | Nhận ra bằng | Thư mục cài | `alp update` |
|---|---|---|---|
| `binary` | executable dưới `versions/vX.Y.Z` + manifest | `~/.alp-code` | checksum → staging/smoke → atomic `current` |
| `npm` | wrapper metadata + exact payload manifest | npm sở hữu wrapper; cache per-user | `npm install -g alp-code@<version>` |
| `dev` | có `.git` **và** `src/` | clone của người phát triển | checkout tag rồi build tại chỗ |

Binary không bao giờ sửa tại chỗ: archive và `SHA256SUMS` được tải có size cap; tar path/link,
manifest target/version, asset và staged `--version` được kiểm trước rename. Pointer chỉ đổi
sau khi version đầy đủ; failure sau cutover tự lùi về previous và chỉ prune sau state bootstrap.

### 6.2 Hook forwarder

`alp init` ghi `<project>/.claude/settings.local.json` bằng merge có ownership marker và command
`<stable-command> hook session-boot`. `ensureState` đọc project registry để repair entry
`session-boot.cjs` v0.9 mà không đụng hook/field khác. Packaged skill được link vào hai runtime
qua stable `current` asset root; npm transition repair link từ payload cũ sang payload mới.

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
| Unit | `test/{agents,policy,memory,execution,workflow,runtime,context}` | invariant từng layer — `context/` gồm checkpoint, journal, payload normalizer, continuity renderer |
| Contract | `test/memory/memory-store.contract.ts` | `MarkdownFileStore` và `RemoteApiStore` cùng hành vi |
| Integration | `test/{delegation,backend,hooks,cli}` | ghép layer, deny ordering, hook enforcement, `alp context` CLI |
| E2E | `test/e2e/` | 5 suite, dựng fake `claude`/`codex` binary — kiểm launch contract, delegation, memory isolation, runtime selection, compact bridge (pin → fixture pre/post → reinject) mà không tốn tiền model |
| Cutover | `test/cutover/no-legacy-identity.test.ts` | không còn identity Markdown sót lại |
| Cross-platform | 12 × `scripts/test-*.cjs` | CLI link, Codex role, backend, hook, installer POSIX/Windows, state `~/.alp`, nội dung artifact phát hành, update, uninstall |

`scripts/test-uninstall.cjs` có process-level fixture chứng minh CLI hoàn tất được ngay cả khi
nó vừa xoá chính thư mục chứa code của mình. `scripts/test-installer.cjs` chạy `install.sh`
thật với `curl`/`npm` giả trong PATH, và `scripts/test-pack-release.cjs` đọc danh sách file mà
`npm publish` sẽ gửi đi — hai chỗ mà lỗi chỉ lộ ra ở máy người dùng, sau khi đã phát hành.

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
| `alp doctor [--quiet]` | artifact/target/current/stable command, registry, memory/execution/delegation state. Exit `0` healthy · `1` có finding · `2` doctor lỗi |
| `alp update` | cập nhật theo channel (binary / npm / dev clone); `~/.alp` không bị đụng |
| `alp uninstall [--purge-memory] [--force]` | gỡ bản cài theo channel; backup memory; trong `~/.alp` chỉ xoá thứ của alp-code |
| `alp delegation health [backend]` | health check backend |
| `alp delegation list` | execution record đang theo dõi |
| `alp context status\|validate [execution-id]` | xem/kiểm checkpoint + journal compact bridge |
| `alp context pin\|unpin` | chốt hoặc gỡ một decision/constraint/open-item/next-action |
| `scripts/bootstrap.cjs [--no-path]` | build (chỉ dev clone) → `ensureState` → validate registry + adapter → doctor → link CLI |
| `scripts/ensure-state.cjs [--quiet]` | dựng `~/.alp`, ghi lại hook forwarder và install record |
| `scripts/pack-release.cjs [--out …]` | dựng wrapper npm + native archives/checksums, dừng trước publish/upload |

## 11. Câu hỏi còn mở

- `DelegationService.prepare` gọi `void this.policy` / `void this.memory` — hai dependency này
  được inject nhưng chưa dùng trực tiếp (mọi authorization hiện đi qua `ExecutionService`).
  Nên bỏ khỏi constructor, hay giữ cho hướng mở rộng đã định trước?
- `alp delegate` và `alp` dùng hai `FileExecutionStore` root khác nhau
  (`~/.alp/executions` vs `<stateDir>/execution-snapshots`). Có chủ ý tách, hay nên hợp nhất
  để doctor và hook chỉ nhìn một nơi?
- `RemoteApiStore` đã có contract nhưng chưa có `MemoryApiClient` implementation nào ngoài fake
  trong test — server-backed memory đang ở lộ trình nào?
