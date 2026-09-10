# ALP Code — Triết lý thiết kế & Tầm nhìn kiến trúc

> **Status:** Draft · **Ngày:** 2026-08-27 · cập nhật 2026-09-04 (§0, §4.6, §10.3), 2026-09-10
> (§5.8, §8, §11 — đối chứng Amp) · **Owner:** anhlp
> **Quan hệ với các doc khác:** `docs/architecture.md` mô tả hệ thống **đang là**. Doc này mô tả
> hệ thống **nên trở thành** và các nguyên tắc để quyết định từng bước đi. Khi hai doc mâu thuẫn,
> `architecture.md` đúng về hiện trạng, doc này đúng về hướng.

---

## 0. Thuật ngữ

Bản nháp trước dùng một từ "Harness" cho hai thứ nằm ở hai phía đối diện của ALP. Doc này tách chúng:

| Thuật ngữ | Nghĩa | Hôm nay là gì |
|---|---|---|
| **Principal** | Con người ra quyết định cuối cùng | Người dùng |
| **Surface** | Nơi principal tương tác, gọi *vào* ALP. Nằm **trên** ALP | `alp` CLI; một phiên Claude Code gọi `alp delegate` |
| **Runtime** | Tiến trình chạy vòng lặp model, do ALP **khởi chạy**. Nằm **dưới** ALP | Claude Code (`claude`), Codex CLI (`codex`) |
| **Backend** | Nơi tiến trình runtime thực sự chạy | `LocalProcessBackend`: child process + supervisor detached cho background |
| **Agent** | Đơn vị identity **đầy đủ**: một mục đích cụ thể, cộng trọn bộ phương tiện để phục vụ mục đích đó — tool, skill, subagent, MCP server, memory, workspace | 8 agent trong `src/agents/`, nhưng `capabilities` mới có tool, memory, workspace |
| **Agents team** | Tập agent đã đăng ký trong registry, cùng quan hệ `reportsTo`/`delegatesTo` giữa chúng. Thành viên của team là Agent, **không** phải subagent | `main` + 7 specialist |
| **Subagent** | Đơn vị thực thi **phụ thuộc**, sống bên trong tiến trình runtime của một agent. Không identity, không memory, không policy snapshot, không execution record — nó là một **grant** của agent, ngang hàng skill và MCP server, không phải một chỗ ngồi trong team | Chưa có. Claude Code cấp qua `--agents <json>`; Codex chưa có tương đương |

Điểm dễ nhầm nhất: **Claude Code vừa có thể là surface vừa có thể là runtime.** Khi principal gõ
`alp delegate review` từ trong một phiên Claude Code, Claude Code là surface. Khi
`ClaudeRuntimeAdapter` spawn tiến trình `claude` để chạy agent `review`, Claude Code là runtime.
ALP đứng giữa, và không được phụ thuộc vào chi tiết của bên nào.

**Điểm dễ nhầm thứ hai: Agent không phải subagent.** `search`, `review`, `oracle` là Agent — mỗi vai
có identity, memory, policy snapshot và execution record riêng, và chỉ đến được qua
`DelegationService`. Subagent thì ngược lại: nó chỉ tồn tại trong một tiến trình runtime, không để
lại dấu vết nào ở tầng ALP, và tồn tại để **một** Agent hoàn thành mục đích của chính nó. Nói
"`main` spawn subagent `review`" sai ở cả hai vế. Hệ quả kỹ thuật ở §4.6.

---

## 1. North Star

> **Define agents once. Run them on any runtime, from any surface.**

Đầy đủ hơn:

> ALP là một **launcher code-native, fail-closed cho một nhóm agent** — nó quyết định ai được làm
> gì, ở đâu, với dữ liệu nào, rồi dịch quyết định đó thành lệnh khởi chạy cho một runtime thay thế được.
> Mục tiêu dài hạn là identity, policy, memory và delegation của agent tồn tại độc lập với runtime,
> surface và model provider.

Mọi quyết định kiến trúc lớn nên được đánh giá theo mục tiêu này. Nếu một thiết kế giúp tích hợp một
runtime nhanh hơn nhưng làm agent phụ thuộc runtime đó, đó thường không phải lựa chọn đúng cho core.

Ba invariant hiện hành không thay đổi:

| Invariant | Hệ quả |
|---|---|
| **Identity là code, không phải prompt** | Agent định nghĩa trong TypeScript, freeze khi load, hash vào execution policy |
| **ALP quyết ai giao việc cho ai; backend chỉ quyết execution chạy thế nào** | Policy chạy trước mọi runtime probe / backend health / spawn |
| **Fail-closed** | Unknown tool/path/role/request → deny. Không có nhánh "mặc định cho phép" |

---

## 2. Hiện trạng vs Mục tiêu

Doc này chỉ có giá trị nếu nó thành thật về khoảng cách. Tại `main` (2026-08-27), 61 file, ~5.4k dòng TS:

| Vùng | Hiện trạng | Mục tiêu | Khoảng cách |
|---|---|---|---|
| Agent identity | 8 agent TS, freeze + hash | + custom agent declarative có trần capability; + built-in `orchestrator` | **Chưa có** — §5, §5.9 |
| Bề mặt của agent | `AgentCapabilities` = tool + memory + workspace | + skill, subagent, MCP server **theo từng agent**, pin trong `ExecutionPolicy` | **Chưa có** — §0, §4.6, §5.5 |
| Công cụ test agent | `npm test` (unit, registry giả) | `alp agent test`: static → dry-run prepare → deny-path → live, chạy được cả agent built-in | **Chưa có** — §10.3 |
| Policy | `PolicyEngine` fail-closed, nhị phân allow/deny | + `require_approval` là quyết định của core | **Chưa có** — §6 |
| Delegation | `DelegationService` → policy → backend, deny-first | Giữ nguyên | ✅ Đạt |
| Tool | `TOOL_CATALOG` hardcode từ vựng Claude Code | Capability là kiểu chính; tên tool sống trong adapter | **Ngược hướng** — §4.5 |
| Runtime | `ClaudeRuntimeAdapter`, `CodexRuntimeAdapter` | Giữ hai runtime này | ✅ Đạt |
| Skill | 17 skill trong `skills/`, được **runtime** nạp; skill root là danh sách chung lấy từ env | ALP sở hữu selection + budget; skill root theo từng agent, pin trong policy | **Chưa có engine** — §4.4, §5.7 |
| Không gian project | `alp init` ghi `~/.alp/projects.json` **và** render `.alp/agents/<role>.md` + cài `SessionStart` hook, loại trừ qua `.git/info/exclude` | `alp init` tạo `.alp/` cho agent + skill của project | **Một phần** — §5.7 |
| Memory | `MemoryService` + adapter (markdown / remote API) | Giữ nguyên | ✅ Đạt |
| Context | Grant lọc trong `IdentityCapsule` | `ContextEngine` có budget rõ ràng | Một phần |
| Observability | executionId, parent role qua env | trace parent→child→tool ghép được | Một phần |
| Plugin / Workflow engine / Cloud | — | — | **Cố ý hoãn** — §8 |

Hai chỗ "ngược hướng" là nợ kiến trúc thật, không phải tính năng thiếu. Chúng nên được trả trước
khi thêm runtime hoặc surface thứ ba.

---

## 3. Vì sao portability quan trọng khi mới có hai runtime

Câu hỏi hợp lý: với đúng Claude và Codex, phần lớn abstraction trong doc này có phải đầu cơ không?

Trả lời: **hai đã đủ để lộ mọi rò rỉ.** Bằng chứng cụ thể trong repo hôm nay —
`src/hooks/execution-bridge.ts:207` map `apply_patch` của Codex ngược về `Write`/`Edit` của Claude.
Từ vựng tool của Claude Code *chính là* từ vựng của core, còn Codex bị dịch về nó. Chưa cần runtime
thứ ba, abstraction đã rò.

Nên nguyên tắc là: **abstraction chỉ được xây khi có hai implementation thật đang chịu đau.** Hai
runtime đủ để biện minh cho capability layer. Chúng **không** đủ để biện minh cho plugin registry,
workflow DSL, hay cloud execution — xem §8.

---

## 4. Nguyên tắc kiến trúc

### 4.1. Dependency chỉ đi một chiều

```text
surface  →  ALP  →  runtime  →  backend
```

Layer trên import layer dưới, không bao giờ ngược lại. `policy/` không biết runtime; `agents/`
không biết backend; `memory/` không biết execution.

Dependency cụ thể tới Claude Code hoặc Codex CLI chỉ được phép xuất hiện trong `src/runtime/` và
`hooks/`. Nếu tên `claude` hoặc `codex` xuất hiện trong `agents/`, `delegation/`, `policy/`,
`memory/` hay `execution/`, đó là dấu hiệu abstraction đang rò — trừ một ngoại lệ đã biết và chấp
nhận: `RuntimeModelMap` (xem §4.12).

### 4.2. Core sở hữu contract, không sở hữu implementation

Core định nghĩa *cái gì*. Adapter và provider quyết định *bằng cách nào*.

Core sở hữu: `AgentDefinition`, `Capability`, `ExecutionPolicy`, `PolicyDecision`,
`DelegationRequest`, `MemoryScope`, `WorkflowDefinition`, `OutputContract`.

Core không sở hữu: model provider cụ thể, CLI cụ thể, database cụ thể, MCP server cụ thể, UI cụ thể.

### 4.3. Runtime sở hữu execution

Definition mô tả intent và capability. Nó không tự thực thi.

```text
AgentDefinition → ExecutionService → RuntimeAdapter → Backend
```

Không extension, hook hay skill nào được tạo một đường execution riêng để đi vòng qua
`ExecutionService`. Đây là điều kiện để policy, budget, cancellation và tracing áp dụng đồng đều.

### 4.4. Skill là knowledge, không phải agent

Skill trả lời: *"Agent nên tiếp cận việc này như thế nào?"* Skill có instructions, convention,
domain knowledge, reference, script. Skill **không** có lifecycle, không sở hữu model, không delegate,
không phải execution runtime.

```text
skills/      = nội dung
src/skills/  = engine
```

Hai thứ này không được trộn. Hôm nay `src/skills/` **chưa tồn tại** — 17 skill trong `skills/` đang
được skill loader của runtime nạp, nghĩa là ALP chưa kiểm soát skill nào vào context, lúc nào, tốn
bao nhiêu token. Đây là chỗ portability thủng to nhất hiện tại.

Khi xây engine, câu hỏi phải trả lời không phải "để file ở đâu" mà là **ai chọn skill nào để nạp**.
Đó là quyết định context budget, thuộc về §4.9.

**Skill root là một quyền đọc, không phải một đường dẫn tiện lợi.** Điều này dễ bị bỏ sót:
`execution-bridge.ts:93-102` cho phép agent đọc file nằm dưới bất kỳ skill root nào, kể cả ngoài
`workspace.readRoots`. Nên mỗi skill root thêm vào là một lần nới quyền đọc, và tập root phải:

1. đi vào `ExecutionPolicy` (như `allowedTools`), không lấy từ biến môi trường lúc chạy;
2. **theo từng agent**, không phải một danh sách chung cho mọi execution.

Hôm nay nguồn sự thật là env cộng `runtime/skill-roots.json`; đích đến là policy snapshot. Đường
dẫn kỹ thuật đã có sẵn, chỉ cần đổi nguồn.

### 4.5. Capability quan trọng hơn tên tool

Agent không nên bị khoá vào implementation (`ripgrep`, `apply_patch`, `Grep`). Agent khai báo nhu cầu
ở mức capability; runtime resolve sang tool cụ thể.

```text
Capability  →  CapabilityResolver  →  { Native tool | Runtime tool | MCP tool | Agent tool }
```

**Capability không chỉ là một cái tên.** Nếu `repository.search` có thể được satisfy bởi ripgrep
(local), MCP code-search (network egress) hoặc một SearchAgent (tốn token, ăn delegation depth), thì
`PolicyEngine` không thể ra quyết định fail-closed chỉ từ tên capability. Capability phải mang thuộc tính:

```ts
interface Capability {
  readonly id: string;             // "repository.search"
  readonly sideEffect: "none" | "workspace-write" | "external";
  readonly egress: boolean;        // có rời khỏi máy không
  readonly cost: "cheap" | "model" | "delegated";
}
```

Policy quyết định trên thuộc tính, không trên tên. Đây là điều kiện để §4.7 giữ được ý nghĩa.

Migration này không rẻ: nó chạm `TOOL_CATALOG`, `ExecutionPolicy.allowedTools`,
`WorkflowState.allowedTools`, `definitionHash` và `src/runtime/permission-rules.ts` — nơi ACL khai
báo ra config từng runtime kể từ v0.2.0. Nên làm **một lần, có kế hoạch riêng**, không làm dần.

### 4.6. Agent đi qua delegation; subagent là grant trong runtime

Hai thứ nằm ở hai tầng khác nhau, và bản nháp trước gọi chung là "subagent" nên trộn mất ranh giới
enforcement.

**Agent ngang hàng.** Model nhìn thấy `delegate.search`, `delegate.review`, `delegate.oracle`.
Implementation không spawn tuỳ ý:

```text
Agent → Agent tool → DelegationService → PolicyEngine → ExecutionService
```

Không bao giờ `Agent → spawn(agent)` trực tiếp. Nhờ đó mọi delegation chung một cơ chế
authorization, quan hệ parent-child, budget, cancellation, structured result, và depth control.

Hệ quả bảo mật cần nói rõ: **delegate là tool nhìn thấy được với model, nên nó là bề mặt prompt
injection.** Thứ chặn thiệt hại không phải là nội dung prompt, mà là `delegatesTo` đã freeze trong
definition và depth/budget do runtime enforce.

Phần này khớp đúng code hiện tại — `ExecutionService.prepare` chạy trước cả resolve runtime và
health check backend, để một request đã bị từ chối không làm rò rỉ sự tồn tại của backend.

**Subagent không đi đường đó.** Nó sống trong tiến trình runtime mà ALP vừa spawn: ALP không thấy
từng lần gọi, không cấp policy snapshot, không ghi execution record. Vậy nó được cấp **một lần, lúc
prepare** — y hệt skill root và tool grant. Definition khai `capabilities.subagents`, adapter dịch
sang cấu hình runtime, và tập đó đi vào `definitionHash`. Cùng luật áp cho MCP server:
`capabilities.mcpServers`.

**Đã code (2026-09-04).** Cả ba trường có thật trên `AgentCapabilities`, bắt buộc khai, và tên được
resolve một lần ở `createExecutionPolicy` qua `src/agents/capability-catalog.ts` — catalog là tập
principal trust, `SUBAGENT_CATALOG` và `MCP_SERVER_CATALOG` rỗng ở v1 đúng theo trần §5.5. Cái đi
vào `ExecutionPolicy` không phải cái tên mà là **spec đã resolve** (`command`, `args`, `egress`,
prompt của subagent), nên `policy.json` trả lời được câu "execution này được phép mở đường ra đâu"
mà không phải tra lại cấu hình máy — thứ có thể đã đổi sau đó. Trần cưỡng chế ở registry: tên lạ bị
từ chối (`UNKNOWN_SKILL`/`UNKNOWN_SUBAGENT`/`UNKNOWN_MCP_SERVER`), subagent không được mang tool mà
agent cha không có, và `Skill` phải đi kèm ít nhất một tên skill — *tool `Skill` mà không nêu tên là
grant lên **mọi** skill root của máy*, đúng hình dạng §5.5 cấm, và đó là thứ cả năm built-in giữ
`Skill` đang có trước hôm nay.

Đây là điều làm nên định nghĩa ở §0: một Agent **tự đủ** cho mục đích của nó. Tool, skill, subagent,
MCP server không phải bốn tính năng rời — chúng là bốn loại phương tiện của cùng một identity, nên
phải khai cùng chỗ, hash cùng lúc, và hiện trong cùng một bảng Authority mà agent đọc được.

Ba thứ phải nói thẳng vì chúng là giá phải trả:

1. **Enforcement chỉ ở mức cấu hình, không ở mức từng call.** Cùng loại mất mát mà
   `architecture.md` đã ghi khi bỏ `acl-guard.cjs`: ALP quyết *tập* subagent, runtime quyết *lần
   gọi*. Bảo đảm duy nhất ALP đưa ra là subagent thừa hưởng workspace, sandbox và deny list của
   agent cha — nó không mở thêm đường ghi hay đường egress nào mà agent cha chưa có. Đừng hứa hơn thế.
2. **House rule đã tách (2026-09-04, làm trước khi có grant đầu tiên).** Câu cũ ở
   `src/agents/shared/house-rules.ts` — `"never launch raw Herdr, Paseo, or in-process agents"` —
   cấm cả loại, nên ngày một definition khai `capabilities.subagents` thì prompt sẽ nói ngược lại
   chính grant đó. Nay là hai rule đi cùng nhau, vì hai lý do khác nhau: Herdr/Paseo bị cấm tuyệt
   đối vì là **runtime lạ ngoài policy**, không grant nào kéo lại được; subagent bị cấm bằng cách
   **không được cấp** — `"Launch no in-process subagent that this execution's policy does not
   grant"`. Rule này không cần viết lại khi grant đầu tiên xuất hiện.

   Cùng lúc, phần enforcement mới được thêm: vòng lặp deny của `permission-rules.ts` chỉ phủ được
   `TOOL_CATALOG` — tool subagent của chính runtime (`Task`/`Agent` của Claude Code) không nằm
   trong đó nên **chưa từng bị deny lần nào**, tức lệnh cấm cũ chỉ tồn tại trong prompt. Giờ hai
   tên đó vào thẳng deny list của mọi execution; khi definition khai được subagent, chính grant sẽ
   là thứ gỡ tên ra. Codex không có tool tương đương nên danh sách này chỉ dành cho Claude.
3. **Bất đối xứng runtime, và cách sống chung với nó.** Claude Code nhận cả hai qua CLI:
   `--agents <json>` cho subagent, `--mcp-config <file>` cộng `--strict-mcp-config` cho MCP — cái
   sau đúng chất fail-closed vì nó bỏ qua mọi cấu hình MCP khác trên máy. Mọi execution delegate
   nay đi kèm cả hai cờ MCP, kể cả khi grant rỗng: file `mcp-config.json` rỗng cộng `--strict` là
   thứ chặn specialist thừa hưởng nguyên bộ MCP server của máy — egress không policy nào duyệt và
   bảng Authority không hề nêu. Phiên interactive vẫn nhận cấu hình máy: cùng một đánh đổi đã ghi
   cho `--dangerously-skip-permissions`, principal ngồi đó và tự duyệt. Codex có `mcp_servers`
   nhưng phải đi qua `-c` trên argv chứ không phải `codex-config.toml` — file đó là bản ghi của
   ALP, Codex đọc `$CODEX_HOME/config.toml` mà ALP không ghi — và Codex **không có
   `--strict-mcp-config`**: grant ở đó chỉ *thêm* server, không lấy bớt. Codex cũng
   **không có subagent in-process tương đương**. Nên design test số 1 của §10.1 sẽ đỏ với bất kỳ
   agent nào lấy subagent làm phương tiện chính. Luật giữ portability: **subagent là tối ưu hoá,
   không phải điều kiện.** Việc gì bắt buộc phải có nó thì việc đó thuộc về một Agent thật, gọi qua
   delegation.

### 4.7. Policy fail-closed, và approval là quyết định của core

Permission không phải gợi ý cho model. Model *đề nghị* hành động; runtime mới *cho phép* hành động
xảy ra. Không có policy decision hợp lệ ⇒ không execute.

Policy áp dụng nhất quán cho: tool, filesystem, workspace, memory, delegation, network, external
side effect.

Hôm nay `Authorization` là nhị phân (`src/policy/types.ts:22`). Đề xuất mở rộng thành ba nhánh — chi
tiết ở §6.

### 4.8. Memory là service, truy cập qua policy

Memory không thuộc riêng agent hay runtime nào.

```text
Agent → Memory API → PolicyEngine → Memory backend
```

Backend (markdown file, remote API, SQLite, vector DB) thay được mà agent contract không đổi. Scope:
`shared`, `shared:<topic>`, `project:<name>`, `private:<agentId>`. Agent chỉ đọc/ghi scope được cấp,
và write grant luôn phải là tập con của read grant — `createAgentRegistry` đã enforce điều này.

### 4.9. Context là tài nguyên hữu hạn

Context không phải nơi dump state. Mọi nguồn context đi qua một điểm có ngân sách:

- system instruction, agent definition, skill, hội thoại, memory, tool result, workspace info,
  delegation result.

Điểm đó chịu trách nhiệm selection, prioritization, truncation, dedup, token budgeting. Skill,
memory và tool **không được tự append context không giới hạn**.

Hôm nay `IdentityCapsule` đã lọc memory theo grant và cắt tool theo workflow state — đó là hạt giống
của context engine. Phần còn thiếu là ngân sách token tường minh và skill selection.

### 4.10. Observability, budget, cancellation là first-class

Hệ multi-agent không debug được bằng log rời rạc. Mọi execution quan trọng cần identity ghép được:
`session_id`, `execution_id`, `agent_id`, `parent_execution_id`, `delegation_id`, `tool_call_id`.

Runtime phải kiểm soát: token budget, tool-call budget, delegation budget, wall-clock timeout, max
delegation depth, max concurrent agent.

Cancellation phải lan xuống. Không được để orphan execution chạy tiếp sau khi parent đã huỷ.

Tracing tồn tại độc lập với surface. Surface chỉ render hoặc forward.

### 4.11. Adapter chỉ dịch, không chứa business logic

Runtime adapter chịu trách nhiệm: dịch `PreparedExecution` → launch spec, map event, map approval
flow, đăng ký capability mà runtime cung cấp, chuyển streaming, đồng bộ lifecycle.

Adapter **không** được chứa: reasoning logic, delegation rule, agent planning, memory policy, core
permission policy. Nếu một adapter đang quyết định "khi nào hỏi principal", nghĩa là core thiếu một
quyết định — xem §6.

### 4.12. Stable core, replaceable edges

Thay được: runtime, backend, model provider, memory backend, tool provider, telemetry, UI.

Thay chậm: `AgentDefinition`, `Capability`, `ExecutionPolicy`, `PolicyDecision`, `Delegation`,
`Session`, `Event`.

Một ngoại lệ đã biết: `AgentDefinition.model: RuntimeModelMap` khoá theo `"claude" | "codex"`. Đây
là runtime coupling nằm ngay trong core contract — mỗi agent phải liệt kê model cho từng runtime.
Với đúng hai runtime, đây là đánh đổi **chấp nhận được và cố ý**: nó giữ mọi thứ tường minh và
review được. Nó chỉ trở thành vấn đề khi có runtime thứ ba; lúc đó nâng lên `model: { class:
"reasoning-heavy" }` + resolver. Không làm trước.

Mọi contract core cần `schemaVersion`. "Define once, run anywhere" chết ở lần bump contract đầu tiên
nếu không có versioning và deprecation policy.

---

## 5. Custom agent: declarative có trần capability

### 5.1. Vấn đề

Principal muốn định nghĩa thêm agent giống 8 agent sẵn có, không phải sửa TypeScript và build lại.

Nhưng "agent declarative" theo nghĩa ngây thơ sẽ phá invariant số một. `definitionHash` +
`policyHash` chỉ có nghĩa vì definition là object đã freeze lúc build. Một file agent đọc từ đĩa lúc
runtime biến `delegatesTo`, memory grant và `workspace.writeRoots` thành **dữ liệu người dùng sửa
được** — và mô hình mối đe doạ đổi hoàn toàn.

Nên câu trả lời không phải "declarative thay cho code", mà là **hai tầng**.

### 5.2. Hai tầng identity

| | Built-in agent | Custom agent |
|---|---|---|
| Nguồn | TypeScript trong `src/agents/` | File dữ liệu trong `.alp/agents/` |
| Tin cậy | Trusted, đi kèm binary | Untrusted cho tới khi principal trust |
| Trần capability | Không (do code định nghĩa) | Có, cưỡng chế lúc load |
| `reportsTo` | Bất kỳ | Bắt buộc `main` |
| `delegatesTo` | Bất kỳ | Bắt buộc rỗng (là lá) |
| Hash | `hashAgentDefinition` | `hashAgentDefinition` — **cùng một hàm** |

Điểm then chốt: custom agent **không phải một primitive mới**. Loader dựng ra một
`AgentDefinition` bình thường, rồi đưa qua đúng `createAgentRegistry` hiện có — nên nó thừa hưởng
toàn bộ invariant đã có: cycle detection, memory write ⊆ read, workspace write ⊆ read, unknown tool,
private scope ownership.

### 5.3. Vì sao `instructions` (một hàm) vẫn declarative được

Câu hỏi khó nhất trong bản nháp, và có lời giải sạch, vì `instructions` **hiện đã là dữ liệu cộng
một template cố định**. Xem `src/agents/review.ts:21-25`:

```ts
instructions: () => renderInstructions(
  "Review, the code review specialist",   // role
  "Review one named concern per execution…", // purpose
  [...CODE_NATIVE_HOUSE_RULES, ...CODE_CRAFT_RULES, "Do not edit…"], // rules
)
```

v0.2.0 bỏ tham số `context` khỏi `instructions`, và điều đó **củng cố** lập luận ở đây: identity
giống hệt nhau giữa mọi execution nên render được một lần ra file cho `SessionStart` hook đọc, còn
workspace và task chuyển sang prompt của từng execution — đúng ranh giới mục này vẫn muốn.

Không có logic. Chỉ có `role`, `purpose`, `rules[]` được đưa vào một template chung. Vậy custom
agent khai báo đúng ba thứ đó:

```yaml
# <project>/.alp/agents/migrator/agent.yaml
schemaVersion: 1
id: migrator
displayName: "Migrator 🔧"

model:          { claude: claude-opus-5, codex: gpt-5.6-terra }
reasoningEffort: { claude: high, codex: medium }

instructions:
  role: "Migrator, the framework migration specialist"
  purpose: "Migrate one module per execution and prove the migration with tests."
  houseRules: code-native+craft      # tập rule dựng sẵn, không tự do
  rules:
    - "Never migrate more than one module per execution."
    - "Report the diff surface before changing anything."

capabilities:
  tools: [Read, Glob, Grep, Bash]
  skills:     [framework-migration]   # tên skill trong scope, không phải đường dẫn
  subagents:  []                      # tên subagent runtime — rỗng ở v1, §5.5
  mcpServers: []                      # tên server principal đã khai và trust
  memory:
    read:  [shared, "project:*", "private:migrator"]
    write: ["private:migrator"]
  workspace:
    readRoots:  ["."]
    writeRoots: []

workflow:
  - { id: ASSESS,  allowedTools: [Read, Glob, Grep] }
  - { id: MIGRATE, allowedTools: [Read, Glob, Grep, Bash] }
  - { id: VERIFY,  allowedTools: [Read, Glob, Grep, Bash] }
  - { id: REPORT,  allowedTools: [] }

output:
  kind: text
```

Loader gọi `renderInstructions(role, purpose, [...HOUSE_RULES[houseRules], ...rules])`.

Ràng buộc bắt buộc:

- **Không có template engine.** Principal không kiểm soát vị trí `${task}` / `${workspace}`;
  `renderInstructions` chèn chúng. Không interpolation, không điều kiện, không vòng lặp.
- **`houseRules` chọn từ tập dựng sẵn** (`none` | `code-native` | `code-native+craft`), không phải
  tự viết. House rule là nơi các bất biến của hệ thống sống; principal thêm rule riêng ở `rules`.
- **`rules` có giới hạn**: mỗi rule ≤ 240 ký tự, tối đa 20 rule. §4.9 — context là hữu hạn, và một
  agent definition không được lặng lẽ ăn hết ngân sách.
- **`skills`, `subagents`, `mcpServers` khai bằng tên, không bằng đường dẫn hay lệnh.** Một custom
  agent không được tự mô tả cách khởi chạy một MCP server hay tự trỏ ra một skill root mới — nó
  chọn trong tập principal đã khai và đã trust. Cùng luật với `houseRules`: chọn từ tập dựng sẵn,
  không tự do viết. Cả ba trường vào `definitionHash`, nên nới quyền là một lần trust lại (§5.6).
- **`instructionSpec` phải được lưu như dữ liệu trên `AgentDefinition`**, không chỉ đóng trong
  closure. Lý do rất cụ thể: `canonicalize` (`src/execution/execution-policy.ts:18`) hash hàm bằng
  `.toString()`. Mọi custom agent dùng chung một closure sẽ cho **cùng một chuỗi hàm** — hash mất
  khả năng phân biệt. Lưu spec thành dữ liệu thì `definitionHash` phủ đúng nội dung prompt.
  **2026-09-10: đã làm.** `instructions` trên definition nay là `InstructionSpec` (`role`,
  `purpose`, `rules[]`, `audience?`); tám vai built-in khai dữ liệu, `renderInstructions(spec)`
  dựng chuỗi lúc cần. Đo trước khi sửa: hai definition chỉ khác nội dung prompt, dựng qua cùng
  một closure, cho **cùng một `definitionHash`** — nghĩa là §5.6 không chỉ mất khả năng phân
  biệt mà còn tệ hơn: một hash đã trust sẽ nghiệm đúng cho một prompt khác. Test ghim ở
  `test/execution/identity-capsule.test.ts`.

### 5.4. Output contract không cho phép code

v0.2.0 bỏ output JSON khỏi cả 8 built-in role; validator còn lại là "chuỗi không rỗng". Lý do không
phải JSON khó, mà là **không ai đọc nó**: schema sinh từ Zod bị nhét vào prompt, Stop hook chặn khi
output không parse được, nhưng không consumer nào bóc field ra dùng — contract không người đọc chỉ
là thuế đặt lên prompt. Nên với custom agent v1, `kind: text` là lựa chọn **duy nhất**. Chỉ mở lại
`kind: json` khi có consumer thật đọc field cụ thể — lúc đó schema là **tập con JSON Schema** ALP
compile sang validator: `object`, `string`, `number`, `boolean`, `enum`, `array`, `required`,
`minLength`, `additionalProperties: false`. Kể cả khi đó, cố ý **không** hỗ trợ `pattern` (regex
người dùng cung cấp = rủi ro ReDoS trong tiến trình ALP), không `$ref`, không custom validator.
Contract cần hơn thế thì xứng đáng là built-in agent.

### 5.5. Trần capability

Cưỡng chế lúc load, trước `createAgentRegistry`:

| Trường | Trần |
|---|---|
| `reportsTo` | Bắt buộc `main` |
| `delegatesTo` | Bắt buộc `[]` — custom agent là lá ở v1 |
| `tools` | ⊆ `TOOL_CATALOG` **và** ⊆ tool của `main` |
| `skills` | ⊆ `SKILL_CATALOG` (§5.7; test giữ catalog khớp thư mục `skills/`). Không được thêm skill root mới — root là một quyền đọc, §4.4. Bắt buộc đi cùng tool `Skill`, và ngược lại |
| `subagents` | ⊆ `SUBAGENT_CATALOG`, **rỗng ở v1** nên mọi grant đều bị từ chối. Tool của subagent phải ⊆ tool của agent cấp nó. Catalog mở sau khi `alp agent test` tầng 2–3 tồn tại (§10.3 — nay đã có ở `test/agents/agent-test-tiers.test.ts`) |
| `mcpServers` | ⊆ `MCP_SERVER_CATALOG` (rỗng ở v1). `egress` là trường bắt buộc của mỗi entry, đi vào policy snapshot và in trong bảng Authority; `alp agent add` sẽ in nó khi có (§5.6) |
| `autoCompactTokens` | Map theo runtime (`{ claude?, codex? }`), cùng khuôn với `model` và `reasoningEffort` — ngân sách đi theo model chứ không theo vai một mình. Mỗi phía: 100 000–1 000 000 token nguyên **và** không vượt cửa sổ context của chính model phía đó (`MODEL_CONTEXT_WINDOWS`); vượt là `INVALID_AUTO_COMPACT_LIMIT` lúc load, vì một ngưỡng transcript không bao giờ chạm tới chỉ làm runtime rơi về chốt cứng của nó trong im lặng. Phía bỏ trống nhận **90% cửa sổ của model phía đó**, do ALP tự tính chứ không nhường cho runtime, vì hai runtime nén ở hai chỗ khác nhau. Biên chung là biên Claude công bố cho `autoCompactWindow`; Codex không công bố biên nào cho `model_auto_compact_token_limit` |
| `model` / `reasoningEffort` | Bắt buộc khai đủ hai phía, nhưng với tám vai built-in phần khai đó chỉ còn là chỗ dựa: **nấc** (`low`/`medium`/`high`/`ultra`/`puck`, §4.1 architecture) ghim đúng **một** model cho mỗi vai và ghi đè lúc phóng. Vì mỗi vai chỉ còn một model, **model quyết định runtime** — không còn ai chọn CLI, nên custom agent phải khai model mà `MODEL_RUNTIMES` biết. Cùng một definition chạy năm model khác nhau, nên `ExecutionPolicy.mode` phải ghi lại nấc đã chạy — không thì `policy.json` mô tả một execution mà nó không mô tả nổi. Nấc gõ sai dừng ngay chứ không rơi về mặc định |
| `memory.write` | Chỉ `private:<id>` |
| `memory.read` | `shared`, `shared:*`, `project:*`, `private:<id>` |
| `workspace.writeRoots` | Rỗng, **trừ khi** principal approve — §6 |
| `id` | Không đụng id built-in; không rỗng; kebab-case |

`delegatesTo: []` ở v1 là có chủ ý: cho custom agent delegate sẽ đẻ ra cycle mới, depth mới, budget
mới, và một cây quan hệ mà principal không viết ra. Mở sau, khi có nhu cầu thật.

**2026-09-10: trần này đã được cưỡng chế** (`src/agents/loader/ceiling.ts`), cộng ba ràng buộc
bảng trên chưa nói ra vì chúng chỉ lộ khi viết loader thật:

| Trường | Trần thêm | Vì sao |
|---|---|---|
| `workspace.readRoots` | phải là đường dẫn tương đối, không `..`, không tuyệt đối | `readRoots: ["/"]` là quyền đọc trên máy chứ không phải trên project; `"."` vẫn resolve theo workspace của chính execution |
| `houseRules` bỏ trống | nhận `code-native`, không phải `none` | im lặng trong một definition không phải lời xin bỏ invariant của hệ thống |
| `id` | phải trùng tên thư mục chứa nó | `.alp/agents/migrator/agent.yaml` khai `id: review` sẽ làm hai nguồn sự thật cãi nhau, và cái thắng là cái principal không nhìn thấy |

### 5.6. Trust: hash pin, fail-closed

Agent file nằm trong repo. Repo có thể được clone về từ nơi khác. Nên:

1. `alp agent add <path>` → validate → in ra **toàn bộ capability** dưới dạng người đọc được →
   principal xác nhận.
2. Hash của definition đã normalize được ghi vào `~/.alp/trusted-agents.json`.
3. Mỗi lần load, hash lại. Khác hash ⇒ **deny**, không phải cảnh báo. Principal chạy lại
   `alp agent add` để xem diff và trust lại.
4. Agent chưa trust không xuất hiện trong `main.delegatesTo`, không gọi được.

Đây là cùng một triết lý fail-closed đang áp cho tool và path, mở rộng cho identity.

**2026-09-10: đã làm** (`src/trust/`, `alp agent add|list|untrust`). Ba điều chỉnh so với bản
phác trên:

1. **Trust khoá theo cả project lẫn id**, không chỉ id — hệ quả trực tiếp của quyết định 2
   (agent là project-scoped). Hai repo cùng có `migrator` là hai quyết định khác nhau.
2. **Record giữ một snapshot authority**, không chỉ hash. Hash trả lời "có đổi không" và không
   bao giờ trả lời "đổi cái gì"; bước 1 của mục này đòi in diff lúc trust lại, mà diff cần
   authority cũ chứ không phải dấu vân tay của nó.
3. **`alp agent add` chạy đủ ba tầng trước khi hỏi.** Một agent không qua nổi deny-path test của
   chính nó là agent mà trần capability chỉ là lời hứa — đúng thứ quyết định 11 đặt ra thứ tự cho.

Một hệ quả vận hành phải ghi nhận, đo được sau khi làm xong: `definitionHash` phủ **cả house
rule**, mà house rule ship cùng ALP. `alp update` đổi một house rule sẽ làm hash của **mọi**
custom agent lệch đi dù file không ai đụng, và chúng bị deny cho tới khi trust lại. Đúng về mặt
fail-closed — prompt đã đổi thật — nhưng thông báo phải nói ra nguyên nhân, nếu không nó đang ám
chỉ principal đã sửa thứ họ không sửa. Notice vì thế phân biệt hai trường hợp bằng
`diffAuthority`: quyền đổi (in diff) hay chỉ prompt/workflow đổi (nói thẳng rằng một bản cập nhật
ALP làm được điều này).

### 5.7. `.alp/` — không gian mở rộng của project

`alp init` tạo `.alp/` trong project. Đây là nơi principal thêm agent và skill riêng cho project đó.

**v0.2.0 đã chiếm trước một phần không gian này:** `alp identity sync` render 8 built-in role thành
file phẳng `.alp/agents/<role>.md` (0600), còn layout dưới đây đặt custom agent vào thư mục
`.alp/agents/<id>/` cùng cấp. Loader phải phân biệt **file `.md` = identity, thư mục = định nghĩa**;
luật "`id` không đụng id built-in" ở §5.5 vì thế là điều kiện đúng đắn, không phải phép lịch sự.

**2026-09-10 — hết va chạm:** identity document đã chuyển sang `~/.alp/agents/<role>.md`
(`state-paths.agentsDirectory`), nên `<project>/.alp/agents/` giờ hoàn toàn thuộc về principal.
Loader vẫn chỉ đọc thư mục và bỏ qua file, nhưng đó là phòng xa chứ không còn là điều kiện.
`alp init` tạo `.alp/agents/` và `.alp/skills/` **rỗng**: `.alp/` là thứ duy nhất init chạm mà
principal được commit nên không thể nằm trong `.git/info/exclude`, và một file bất kỳ ghi vào đây
sẽ làm bẩn `git status` từ một lệnh hứa không làm thế. Git không track thư mục rỗng, nên không
gian tồn tại mà không nói gì; `alp agent list` giải thích layout đúng lúc có người hỏi.

```text
<project>/.alp/
├── README.md                   # init sinh ra: giải thích layout
├── agents/main.md              # v0.2.0: identity render sẵn cho SessionStart hook (0600)
├── skills/                     # skill dùng chung cho mọi agent của project
│   └── house-conventions/
│       └── SKILL.md
└── agents/
    └── migrator/
        ├── agent.yaml          # §5.3
        └── skills/
            ├── framework-migration/        # skill RIÊNG của agent — thư mục thật
            │   └── SKILL.md
            └── house-conventions -> ../../../skills/house-conventions   # symlink tới shared
```

Ba dạng entry hợp lệ trong `agents/<id>/skills/`:

| Dạng | Khi nào dùng |
|---|---|
| **Thư mục thật** | Skill chỉ có nghĩa với agent đó, không đáng đưa ra dùng chung |
| **Symlink** tới `.alp/skills/<name>` | Skill dùng chung, agent này được cấp |
| **File `<name>.skillref`** — một dòng, đường dẫn tương đối tới `.alp/skills/<name>` | Như symlink, cho Windows không bật developer mode và cho các checkout git không giữ được symlink |

Cả ba chịu chung luật escape ở §5.7.2. `.skillref` tốn khoảng 15 dòng loader và gỡ hẳn một rào nền
tảng, nên nó xứng đáng có mặt từ v1.

Điểm chung: **thư mục chính là danh sách grant.** Agent chỉ thấy skill được đặt hoặc được trỏ vào
`skills/` của nó, không phải toàn bộ `.alp/skills/`. Không có trường `skills: [...]` trong
`agent.yaml` — một nguồn sự thật, không phải hai thứ để lệch nhau.

**2026-09-10 — sửa lại: có `skills:`, nhưng nó khai một thứ khác.** Câu trên không sống sót qua
chỗ skill built-in thật sự nằm. Bản cài native giữ chúng ở `~/.alp-code/versions/<tag>/skills`,
và `alp update` thay nguyên khối thư mục đó. Một symlink hay `.skillref` **tương đối** trỏ tới
`git` vì thế trỏ vào một đường dẫn sẽ biến mất ở lần cập nhật kế tiếp — file commit vào repo
không thể trỏ tới một chỗ di chuyển được. Nên hai grant được tách theo **thứ chúng diễn đạt nổi**:

| Grant | Khai ở đâu | Cho cây nào |
|---|---|---|
| Skill built-in | `capabilities.skills: [git]` — tên trong `SKILL_CATALOG` | Cây ALP sở hữu và thay khi update |
| Skill của project | Một entry trong `.alp/agents/<id>/skills/` | Cây project sở hữu, đi cùng repo qua git |

Không cái nào nói được điều cái kia nói: một tên catalog không trỏ được vào project, một entry
thư mục không trỏ bền vững vào cây built-in. Loader từ chối khi cùng một tên xuất hiện ở cả hai
chỗ, nên nỗi lo "hai nguồn sự thật cho một quyết định" ở câu gốc vẫn được giữ.

#### 5.7.1. Thứ tự resolve và trùng tên

Skill root của một execution được dựng theo thứ tự, first-match-wins:

```text
1. <project>/.alp/agents/<id>/skills/     ← chỉ agent đó thấy
2. <project>/.alp/skills/                 ← chỉ khi được link ở (1)
3. <repoRoot>/skills/                     ← 17 skill built-in
4. ~/.agents/skills/ , runtime home skills
```

Trùng tên là chuyện sẽ xảy ra. Luật: **cụ thể thắng chung.** Một `code-review` trong
`agents/migrator/skills/` che `code-review` built-in, cho đúng agent đó, và không ảnh hưởng agent
khác. `alp agent show <id>` phải in ra thứ tự resolve đã tính, để việc che này nhìn thấy được chứ
không âm thầm.

Quan trọng: đây **không phải** một danh sách chung nữa. Mỗi execution nhận tập root của riêng nó,
pin trong `ExecutionPolicy` — §4.4.

**2026-09-10: đã làm.** `ExecutionPolicy.skillRoots` mang root của chính vai đó và cả hai adapter
đặt nó lên **đầu** danh sách, nên "cụ thể thắng chung" là hành vi thật chứ không phải mô tả.
`alp agent show <id>` in thứ tự đã tính, kèm từng binding và nơi nó resolve tới.

#### 5.7.2. Symlink escape phải bị deny

Skill root là quyền đọc (§4.4). Một symlink trong `agents/<id>/skills/` trỏ tới `~/.ssh` hay `/`
sẽ biến quyền đọc skill thành quyền đọc bất cứ đâu, và nó vượt qua `workspace.readRoots` một cách
im lặng.

Luật, cưỡng chế lúc load, áp cho cả symlink lẫn `.skillref`:

1. `realpath` mọi entry dưới `.alp/agents/<id>/skills/`.
2. Đích phải nằm trong `<project>/.alp/skills/` hoặc `<repoRoot>/skills/`. Ngoài hai nơi đó ⇒
   **deny cả agent**, không phải bỏ qua riêng link đó.
3. Không đi theo symlink lồng nhau quá một cấp.
4. Nội dung `.skillref` phải là một đường dẫn tương đối, một dòng, không `..` vượt khỏi `.alp/`.

`src/memory/adapters/memory-path-mapper.ts:53` đã xử đúng lớp lỗi này cho memory path. Cùng một
biện pháp, áp cho skill.

#### 5.7.3. Ngân sách

Skill directory không giới hạn là một lỗ thủng của §4.9. Ràng buộc: tối đa 20 skill mỗi agent, và
loader chỉ đọc **frontmatter** của `SKILL.md` khi liệt kê — thân skill chỉ vào context khi được gọi.

#### 5.7.4. `.alp/` commit vào git, `trust` thì không

`.alp/` là tài sản của repo: agent và skill của project nên được review qua PR như code. Nhưng
`~/.alp/trusted-agents.json` nằm ở home và **không** đi theo repo. Nên clone một repo lạ về không
làm agent của nó chạy được — principal phải `alp agent add` một lần và nhìn thấy capability trước
khi trust (§5.6).

**Định nghĩa thì chia sẻ được, sự tin cậy thì không.** Đây là ranh giới giữ cho `.alp/` an toàn khi
đi qua git.

Hai hệ quả vận hành phải ghi nhận:

- `alp init` **đã** chạm working tree từ v0.2.0, giữ `git status --porcelain` sạch bằng
  `.git/info/exclude` chứ không phải bằng cách né. Cơ chế đó dùng lại được cho `.alp/` custom agent,
  khác một điểm: `.alp/agents/<id>/` là thứ principal **muốn** commit nên phải ngoài exclude list.
- `alp deinit` chỉ unregister và dọn artifact do ALP tạo. Nó **không được xoá `.alp/`** — đó là nội
  dung do principal viết.

#### 5.7.5. Overlay skill cho agent built-in

8 agent built-in cũng cần skill riêng của project — `review` ở repo này và `review` ở repo khác nên
biết những convention khác nhau. Cơ chế: **cùng một cơ chế**, không thêm gì mới.

```text
.alp/agents/review/skills/        # overlay: chỉ thêm skill cho built-in `review`
    house-conventions -> ../../../skills/house-conventions
```

Một thư mục `agents/<id>/` mang id của built-in và **không có `agent.yaml`** là overlay. Nó chỉ
thêm skill, và:

- **Có `agent.yaml` cạnh một id built-in ⇒ deny.** Overlay không được chiếm quyền identity: không
  sửa capability, model, workflow hay output contract của agent built-in.
- Overlay vẫn phải trust như custom agent (§5.6) — nó thay đổi prompt của một agent đã trusted.

**2026-09-10: đã làm.** Overlay đi qua đúng cùng một cơ chế — loader dựng ra definition của vai
built-in kèm skill của project, definition đó được hash và trust như mọi thứ khác. Hai điều chỉnh:
overlay chưa trust **không** deny vai built-in (vai đó chạy với skill shipped của nó, cộng một
dòng notice) — deny cả `review` vì một file bên cạnh chưa được duyệt là hạ cả team vì một phần
thêm chưa ai đọc; và một overlay đặt lên vai **không có tool `Skill`** bị từ chối, vì cấp tool là
sửa capability, đúng thứ mục này cấm.

Giới hạn cần nói thẳng: **hash pin ranh giới, không pin nội dung.** Nó phủ tên skill và realpath đã
resolve, không phủ nội dung `SKILL.md` — skill được sửa liên tục là chuyện bình thường, hash lại
mỗi lần sẽ biến trust thành nhiễu. Nội dung skill là trách nhiệm của code review, đúng như mọi file
khác trong repo.

### 5.8. Vì sao YAML chứ không phải `AGENT.md`

`AGENT.md` (frontmatter + thân markdown tự do) quen thuộc hơn, nhưng thân markdown tự do chính là
thứ đối đầu với §4.9 và §5.3: một prompt không giới hạn, không review được, không đo được, chảy
thẳng vào context. Dữ liệu thuần buộc mọi thứ vào các trường có ngân sách và có thể diff.

Đối chứng bổ sung (2026-09-10): Amp — hệ ALP mượn ý tưởng **nấc** — cũng **không** dùng markdown
tự do cho identity. Nó không có file agent declarative nào cả; custom agent của nó là code
TypeScript bên trong plugin (`amp.createAgent`). Hai hệ loại bỏ cùng một thứ là "prompt tự do
không ngân sách", rồi rẽ về hai phía: ALP chọn dữ liệu, Amp chọn code. Vì sao ALP không đi được
phía code — và ba điểm lệch cấu trúc đằng sau — ở
[`amp-parity-custom-agent-and-plugin.md`](./amp-parity-custom-agent-and-plugin.md).

Đây là khuyến nghị, không phải kết luận — xem §11.

### 5.9. `orchestrator` — role built-in thứ 9

Trần `delegatesTo: []` ở §5.5 loại trừ đúng một loại việc đáng làm: **điều phối nhiều execution dài,
chạy song song, trên workspace tách biệt** (mô hình orchestration của Paseo). Cần `delegatesTo` khác
rỗng nên nó phải là built-in. Ba ràng buộc — không miễn trừ invariant cấm `create_agent`/`paseo`,
§4.10 xong trước, và nó là phép thử của câu "không phải swarm tự do" (§8) — ở
[`orchestrator-vision.md`](./orchestrator-vision.md).

---

## 6. Approval là quyết định của core

### 6.1. Vấn đề

`Authorization` hôm nay là nhị phân. Hệ quả UX: mọi thứ không được phép đều hiện ra là "bị chặn",
không có đường xin phép. Hệ quả kiến trúc còn tệ hơn: mọi surface muốn có UX xin phép sẽ phải tự chế
logic "khi nào hỏi" — tức là core permission policy rò vào adapter, vi phạm §4.11.

### 6.2. Đề xuất

```ts
export type PolicyDecision =
  | { readonly outcome: "allow" }
  | { readonly outcome: "deny"; readonly code: PolicyErrorCode; readonly reason: string }
  | {
      readonly outcome: "require_approval";
      readonly code: PolicyErrorCode;
      readonly reason: string;
      readonly prompt: string;                       // core viết, surface chỉ render
      readonly scope: "once" | "execution" | "session";
    };
```

**PolicyEngine quyết định hỏi cái gì và hỏi ở phạm vi nào. Surface chỉ render prompt và trả lời.**
Adapter không được tự nâng cấp một `deny` thành câu hỏi, cũng không được tự trả lời thay principal.

### 6.3. Quy tắc giữ fail-closed nguyên vẹn

Mỗi surface khai báo `supportsApproval: boolean`.

```text
require_approval  +  surface không trả lời được  ⇒  DENY
```

Không bao giờ ⇒ allow. Cụ thể:

| Ngữ cảnh | `supportsApproval` | Kết quả |
|---|---|---|
| Phiên `alp` tương tác, có TTY | `true` | Hỏi principal |
| `alp delegate --background` | `false` | Deny |
| Specialist đã được delegate | `false` | Deny |
| CI / không TTY | `false` | Deny |

Nghĩa là các specialist được delegate vẫn thuần fail-closed y như hôm nay. Chỉ phiên main tương tác
mới hỏi được — vì chỉ ở đó mới có principal.

Một specialist chạy foreground trong terminal của principal **vẫn deny**, dù về lý thuyết nó hỏi
được. TTY không chứng minh có người đang nhìn, và quan trọng hơn: nếu lá hỏi được thì một agent bị
prompt-inject có thể **tự chế ra câu hỏi** để dụ principal approve. Nguyên tắc:

> **Approval đi lên theo cây, không phát sinh ở lá.**

Specialist cần quyền thì trả về structured result nói rõ cần gì; `main` mới là nơi hỏi principal.

### 6.4. Grant sống ở đâu

- `once` — không lưu.
- `execution` — ghi vào execution record; chết cùng execution.
- `session` — ghi vào session state; chết cùng session.
- Nếu principal chọn "always", đó **không** phải approval nữa: nó ghi vào policy file của project,
  và lần chạy sau `policyHash` sẽ khác. Thay đổi quyền lâu dài phải nhìn thấy được trong hash.

### 6.5. Ba use case mở khoá ngay

1. Custom agent xin `workspace.writeRoots` (§5.5).
2. `Bash` với lệnh mutation — hiện chỉ có deny, và từ v0.2.0 thì cả khả năng *phát hiện* cũng mất:
   `hooks/acl-guard.cjs` bị gỡ cùng guardrail `hasIndirectCommand`, vì ACL khai báo không diễn đạt
   được "chặn `$(...)`, `eval`, `bash -c`, `xargs`". Use case này giờ cần approval runtime dựng lại
   chỗ kiểm tra đó, không chỉ nâng deny thành hỏi.
3. Memory write ngoài `private:` scope.

---

## 7. Primitive

Giữ số primitive thấp. Nếu một feature mới không rõ thuộc primitive nào, kiểm tra xem nó có thật sự
là primitive mới hay chỉ là một implementation của primitive đã có.

| Primitive | Trả lời câu hỏi | Trạng thái |
|---|---|---|
| Agent | Ai chịu trách nhiệm? | Có |
| Capability | Agent cần khả năng gì? | Một phần (đang là tên tool) |
| Tool | Hành động được thực thi bằng gì? | Có |
| Delegation | Việc chuyển cho ai, theo luật nào? | Có |
| Policy | Hành động có được phép không? | Có (thiếu approval) |
| Workflow | Quy trình nhiều bước chạy thế nào? | Có (linear) |
| Memory | Thông tin nào sống qua session? | Có |
| Skill | Agent nên tiếp cận việc này thế nào? | Nội dung có, engine chưa |
| Execution | Một lần chạy là gì, ai trace được? | Có |
| Hook | Logic nào chạy quanh lifecycle? | Có |
| Adapter | Runtime/surface kết nối thế nào? | Có |

Hook là lifecycle interception cho observation, augmentation, validation bổ sung, transformation,
telemetry. **Hook không phải nguồn sự thật của security.** Luồng đúng: `PolicyEngine` → hook bus →
execution. Hook riêng cho một runtime phải nằm trong adapter của runtime đó.

---

## 8. Những thứ ALP cố ý không trở thành — và cố ý chưa làm

### Không trở thành

- **Không phải bản sao Claude Code.** ALP tích hợp với Claude Code nhưng không định nghĩa kiến trúc
  theo lifecycle của nó.
- **Không phải MCP wrapper.** MCP là một tool provider, không phải trung tâm.
- **Không phải một tập prompt.** Skill và agent definition là input cho một runtime có execution,
  policy, memory và observability rõ ràng.
- **Không phải swarm tự do.** Delegation phải có hierarchy, budget, cancellation, policy, structured
  result.
- **Không phải một CLI duy nhất.** CLI chỉ là surface đầu tiên.

### Cố ý chưa làm (12 tháng tới)

Repo là 61 file / 5.4k dòng với hai runtime. Danh sách dưới đây là những thứ **không** được xây cho
tới khi có nhu cầu thật, vì mỗi thứ đều tự biện minh được về mặt thẩm mỹ mà không tạo giá trị:

| Hoãn | Điều kiện mở khoá |
|---|---|
| Plugin **bundle dữ liệu** (nhiều `agent.yaml` + `skills/` + tên catalog entry, không code) | §5 xong, **và** có ≥ 2 gói thật muốn dùng lại giữa các project |
| Plugin **có code** / registry | Có ≥ 3 extension bên thứ ba thật, **và** có mô hình signing + sandbox |
| Workflow DSL / engine tổng quát | Có ≥ 2 workflow không diễn đạt được bằng linear workflow |
| Custom agent được delegate | Có use case thật cần cây sâu 2 tầng (built-in `orchestrator` ở §5.9 là đường khác, không phải cái này) |
| `orchestrator` (§5.9) | §4.10 xong: budget, cancellation, trace parent→child |
| Runtime thứ ba | Có người dùng thật cần |
| Cloud execution / ALP Cloud | Sau khi trace và budget đã đầy đủ |
| Tách repo thành `core/ runtime/ extensions/` | Xem §9 |
| Vector memory backend | Markdown + remote API không còn đủ |

Đặc biệt: **plugin system không được xây trước mô hình tin cậy.** Một plugin đóng gói hook và MCP
config là arbitrary code execution. Trong một hệ tự nhận fail-closed, thêm plugin trước khi có
signing/provenance/sandbox là mâu thuẫn tự thân, không phải tính năng.

Amp đi thẳng đường ngược lại — plugin của nó chạy full quyền trong process Amp, không signing,
không sandbox — và với Amp đó là lựa chọn nhất quán. Sao chép nó vào ALP thì không: phần đắt của
plugin có code không phải cái host chạy nó, mà là câu "plugin này được đọc gì, ghi gì, gọi ra mạng
chỗ nào" — tức là dựng lại `AgentCapabilities` cho một chủ thể mới. Chi tiết ở
[`amp-parity-custom-agent-and-plugin.md`](./amp-parity-custom-agent-and-plugin.md) §5.

---

## 9. Cấu trúc repo mục tiêu

Bản nháp trước đề xuất tách thành `core/ runtime/ extensions/ adapters/`. **Đề xuất đó bị loại** ở
giai đoạn này: nó là big-bang refactor cho 5.4k dòng, tạo ra bốn boundary mới để phục vụ hai runtime
và không extension bên thứ ba nào. Nó vi phạm chính YAGNI/KISS mà repo tuyên bố.

Hướng đúng là tiến hoá tại chỗ. Cấu trúc hiện tại đã đúng về mặt phân tách — thứ thiếu là hai thư mục:

```text
alp-code/
├── src/
│   ├── agents/
│   │   ├── shared/            # house rules, voice, principal
│   │   ├── loader/            # custom agent (§5) — có từ 2026-09-10
│   │   └── registry.ts
│   ├── agent-test/            # tầng 1–3 của §10.3; đứng trên agents/policy/execution/runtime
│   │                          # nên không nằm trong agents/ (§4.1)
│   ├── skills/                # ← MỚI: skill engine (§4.4)
│   ├── capability/            # ← MỚI, khi trả nợ §4.5
│   ├── policy/
│   ├── memory/
│   ├── execution/
│   ├── delegation/
│   ├── workflow/
│   ├── runtime/               # claude-adapter, codex-adapter
│   ├── backend/
│   ├── hooks/
│   └── cli/
├── hooks/                     # session-boot.cjs, session-end.cjs (CJS boundary)
├── skills/                    # nội dung skill built-in
└── alp.config.yaml
```

Và trong mỗi project mà principal chạy `alp init` (§5.7):

```text
<project>/.alp/
├── README.md
├── skills/                    # skill dùng chung của project
└── agents/<id>/{agent.yaml, skills/}
```

Quy tắc: thư mục mới chỉ được tạo khi có một primitive mới thật sự, không phải để phản chiếu sơ đồ
trong doc.

---

## 10. Kiểm chứng

### 10.1. Design test — dùng khi review PR

| Câu hỏi | Nếu câu trả lời là "không" |
|---|---|
| Bỏ Codex và chỉ chạy Claude — feature này còn hoạt động? Và ngược lại? | Runtime concern đã rò vào core |
| Custom agent này chạy được trên cả hai runtime mà không sửa file? | Definition đang phụ thuộc implementation |
| Agent đang yêu cầu capability hay hard-code tên provider? | Abstraction cần nâng lên |
| Có đường nào execute mà không qua `PolicyEngine`? | Kiến trúc chưa an toàn |
| Có extension nào tự quản execution loop / cancellation / delegation? | Runtime boundary đang vỡ |
| Trace được execution này từ parent xuống child và tool? | Chưa đạt chuẩn runtime |
| Thêm được bao nhiêu token vào context, ai chịu ngân sách đó? | §4.9 đang bị bỏ qua |
| Agent này tự đủ cho mục đích của nó, hay đang mượn phương tiện của agent khác? | Ranh giới Agent/subagent ở §0 đang nhoè |
| Gỡ hết subagent và MCP của agent này, nó còn làm được việc ở mức thấp hơn không? | Subagent đang là điều kiện chứ không phải tối ưu hoá — §4.6 |
| Grant mới này có deny-path test không? | Trần capability mới chỉ là lời hứa trong doc — §10.3 |

### 10.2. Milestone — bằng chứng, không phải sơ đồ

Doc này chỉ được coi là đang thành hiện thực khi các mốc sau đo được:

- **M0 — Công cụ test agent.** `alp agent test <id>` chạy được tầng 1–3 của §10.3 trên cả 8 agent
  built-in. *Bằng chứng: cho nó chạy trên commit trước bản vá 2026-09-04 thì đỏ ở đúng hai lỗi
  chặn đã tìm ra, chạy trên commit sau thì xanh.*
  **2026-09-10: lệnh đã tồn tại** (`src/agent-test/`, `alp agent test <role|--all>`) và xanh trên
  cả 8 vai (`test/agent-test/command.test.ts`). Phần bằng chứng lịch sử — chạy lại trên commit
  trước bản vá — chưa làm, nên M0 tính là **đạt một nửa**: công cụ có, phép thử ngược chưa chạy.
- **M1 — Portability thật.** Cùng một agent `review` chạy qua Claude và qua Codex, sinh output khớp
  cùng một `OutputContract`, và hai policy trace so sánh được cạnh nhau. *Bằng chứng: một test so
  sánh hai trace.*
- **M2 — Custom agent.** `alp init` tạo `.alp/`; một agent do principal viết trong `.alp/agents/`,
  được trust bằng hash, chạy qua cả hai runtime, và bị deny đúng chỗ khi vượt trần capability.
  Skill riêng của agent và skill được symlink từ `.alp/skills/` đều resolve đúng thứ tự, còn symlink
  trỏ ra ngoài thì deny cả agent. *Bằng chứng: test cho đường allow, đường vượt trần, và đường
  symlink escape.*
  **2026-09-10: xong nửa đầu.** Loader + trần capability có thật, và một `agent.yaml` đi hết ba
  tầng của `alp agent test` trên cả hai runtime (`test/agents/loader.test.ts`,
  `test/agent-test/command.test.ts`), và trust bằng hash cộng nối vào `main.delegatesTo` cũng
  xong (`src/trust/`, `test/trust/trust.test.ts`) — một agent đã trust chạy việc được qua `alp`
  và `alp delegate`. `.alp/skills/`, skill riêng của agent, `.skillref`, luật escape và overlay
  cho vai built-in cũng xong (`src/agents/loader/skills.ts`, `test/agents/skills.test.ts`).
  **M2 coi như đạt**, trừ tầng 4: bằng chứng live trên cả hai runtime vẫn là bước tốn tiền
  chưa chạy.
- **M3 — Approval.** `require_approval` được PolicyEngine phát ra, phiên tương tác hỏi được, và
  `--background` deny. *Bằng chứng: test cho `supportsApproval: false` ⇒ deny.*
- **M4 — Nợ capability đã trả.** `TOOL_CATALOG` không còn là từ vựng của core;
  `execution-bridge.ts` không còn map `apply_patch` → `Write`. *Bằng chứng: grep sạch.*

Thứ tự đề xuất: **M0 → M2 → M3 → M1 → M4.** M0 đứng trước vì M2 là mở cho principal viết identity
chạy với quyền thật — không có deny-path test thì trần capability ở §5.5 không kiểm chứng được. M2
và M3 tạo giá trị trực tiếp cho principal; M4 là nợ kiến trúc nên trả khi đã có đủ áp lực từ hai
runtime, không phải trước.

### 10.3. Công cụ test cho agent

Custom agent (§5) nghĩa là principal viết identity mà không build lại binary, và §0 vừa mở rộng
identity đó thêm ba loại phương tiện. Không có công cụ test, mỗi agent mới là một lần thử trực tiếp
trên việc thật — đúng thứ mà fail-closed sinh ra để tránh. Nên `alp agent test` là **điều kiện để mở
§5**, không phải tiện ích thêm vào sau.

Bốn tầng, rẻ trước đắt sau, dừng ở tầng đầu tiên đỏ:

| Tầng | Kiểm gì | Cần model? |
|---|---|---|
| **1. Static** | schema, trần capability (§5.5), id trùng built-in, workflow reachable + terminal, ngân sách rule/prompt, symlink escape, skill/MCP tên lạ | Không |
| **2. Dry-run prepare** | `ExecutionService.prepare` chạy thật rồi dừng trước spawn: in policy snapshot, capsule, tập skill/subagent/MCP đã resolve, và launch spec của **cả hai** runtime để diff cạnh nhau | Không |
| **3. Deny-path** | Mỗi grant vượt trần phải deny **đúng mã lỗi**, không chỉ "thất bại": workspace ngoài root, private memory của vai khác, tool ngoài catalog, MCP chưa trust, subagent không khai báo | Không |
| **4. Live** | Một task cố định chạy thật trên cả hai runtime; so output với `OutputContract`, so hai policy trace | Có — chạy khi definition đổi, không chạy mỗi commit |

Tầng 2 phải in ra đúng ba thứ principal cần thấy trước khi trust: **quyền** (bảng Authority đúng như
agent sẽ đọc), **egress** (MCP nào ra mạng, có `WebFetch`/`WebSearch` không), và **chi phí** (model,
effort, tập skill sẽ vào context cùng token của nó).

Và nó phải chạy được trên agent **built-in**, không chỉ custom. Hai lỗi chặn tìm thấy khi rà soát
2026-09-04 — ba vai `readRoots: []` không delegate được, và `"."` canonicalize theo cwd của launcher
nên `--project` ngoài cwd luôn deny — nằm gọn trong tầng 2 và tầng 3, và cả hai sống sót qua 336
unit test vì `test/policy/` dựng registry giả với root tuyệt đối. Đó là bằng chứng cụ thể rằng tầng
2–3 không trùng với unit test hiện có, chứ không phải một lớp kiểm tra cho đẹp đội hình.

---

## 11. Quyết định

Các câu hỏi mở của bản nháp đã được chốt như sau. Mỗi quyết định chọn phương án **hẹp hơn** khi hai
phương án ngang nhau về giá trị — nới ra sau rẻ hơn thu lại.

| # | Quyết định | Lý do |
|---|---|---|
| 1 | **`agent.yaml` (YAML thuần)**, không `AGENT.md` | Thân markdown tự do là trường thứ tư không có ngân sách và không diff được — đối đầu §4.9 và §5.3 |
| 2 | **Chỉ project-scoped** `.alp/agents/`. Không có `~/.alp/agents/` | Agent user-scoped chạy trên mọi project = blast radius lớn nhất với review ít nhất. Muốn dùng lại thì copy file — nó là ~40 dòng dữ liệu, và việc mỗi project chỉnh khác đi thường là **đúng**, không phải trùng lặp cần khử |
| 3 | **Trust là danh sách**: agent đã trust tự động vào `main.delegatesTo` | Bắt liệt kê lần hai trong config là hai nguồn sự thật cho cùng một quyết định — đúng lỗi mà §5.7 đã tránh. Hệ quả tốt: tập agent đã trust đi vào `policyHash` của `main`, nên thay đổi quyền nhìn thấy được trong hash |
| 4 | **Khai báo tĩnh + progressive disclosure.** Thư mục quyết định scope; ALP inject **chỉ frontmatter** (name + description) của skill trong scope; model gọi tool `Skill` để nạp thân. Không resolver theo task | 20 skill × frontmatter ≈ vài trăm token — rẻ và tiên đoán được. Một resolver ngữ nghĩa sai âm thầm và tốn nhiều để xây. Khác biệt so với hôm nay: **ALP sở hữu danh sách và ngân sách**, thay vì để runtime tự quyết |
| 5 | **Built-in agent nhận overlay skill** qua `.alp/agents/<builtin-id>/skills/`, không có `agent.yaml` | Một cơ chế duy nhất, không thêm trường config. Chi tiết và ràng buộc: §5.7.5 |
| 6 | **Hỗ trợ cả `.skillref`** cạnh symlink và thư mục thật | ~15 dòng loader, gỡ hẳn rào Windows và các checkout git không giữ symlink |
| 7 | **Giữ deny** cho specialist, kể cả khi có TTY | TTY không chứng minh có người đang nhìn; và lá hỏi được thì prompt injection có thể tự chế câu hỏi để dụ approve. Approval đi lên theo cây — §6.3 |
| 8 | **Hỗ trợ N và N-1**, auto-migrate trong bộ nhớ lúc load; ghi lại file chỉ khi principal chạy `alp agent migrate` | Không im lặng sửa file trong repo của principal. Version < N-1 ⇒ deny kèm hướng dẫn |
| 9 | **Agent ≠ subagent** (§0). Thành viên agents team luôn là Agent có identity đầy đủ — mục đích riêng cộng tool, skill, subagent, MCP, memory, workspace của riêng nó | Một từ dùng cho hai thứ ở hai tầng enforcement khác nhau: cái đi qua `PolicyEngine` từng lần, và cái chỉ được cấp một lần lúc prepare. Bản nháp §4.6 trộn đúng hai cái đó |
| 10 | **Subagent là in-process của runtime**, khai trong definition ngang hàng skill và MCP — không phải một execution con do ALP spawn | Execution con đã có tên: đó là delegation. Thêm loại execution con thứ hai không identity sẽ đẻ ra hai đường làm cùng một việc, và đường thứ hai không trace được (§4.10) |
| 11 | **`alp agent test` (§10.3) chặn trước §5** — không mở custom agent khi chưa có tầng 1–3 | Custom agent là identity do principal viết, chạy với quyền thật. Không có deny-path test thì trần capability ở §5.5 chỉ là lời hứa trong doc |

Quyết định **12–15** (khai đầy đủ thay vì `extends`; plugin v1 là bundle dữ liệu; hook bridge là
event surface duy nhất; `ai.ask`/UI prompt nằm ngoài phạm vi custom agent) nằm ở
[`amp-parity-custom-agent-and-plugin.md`](./amp-parity-custom-agent-and-plugin.md) §6, cùng bằng
chứng từ Amp dẫn tới chúng.

Ba hệ quả của các quyết định trên cần ghi nhận vì chúng tạo ma sát thật:

- **Bump `schemaVersion` làm mất hiệu lực trust cũ** (hash phủ definition sau normalize, mà migrate
  đổi definition). Chấp nhận được **chỉ khi** bump thật sự hiếm — đó chính là cam kết §4.12. Bù lại,
  `alp agent add` in diff capability nên principal thấy ngay là không có gì đổi về quyền.
- **Copy thay vì chia sẻ agent giữa các project** nghĩa là bản sao sẽ trôi khỏi nhau. Đó là đánh đổi
  cố ý, không phải thiếu sót — xem lại nếu có ≥ 3 project dùng cùng một agent và việc trôi gây đau thật.
- **Trust tự động vào `main.delegatesTo`** nghĩa là `alp agent add` là cổng duy nhất. Cổng đó phải in
  đầy đủ capability và chờ xác nhận tường minh — không có chế độ `--yes` cho lệnh này.

### Còn thật sự mở

Ba thứ dưới đây không quyết được bằng lập luận, chỉ quyết được bằng bằng chứng từ sử dụng thật:

1. **Khi nào cần selection thông minh cho skill.** Quyết định 4 đủ tới khi danh sách frontmatter
   chiếm phần đáng kể ngân sách context. Ngưỡng cụ thể chưa biết — đo trước, rồi mới xây.
2. **Custom agent có bao giờ được delegate không** (§5.5 hiện bắt `delegatesTo: []`). Cần một use
   case thật cần cây sâu hai tầng, không phải một use case tưởng tượng ra được.
3. **Ngưỡng trả nợ capability (M4).** Nợ ở §4.5 là thật, nhưng thời điểm trả phụ thuộc mức đau khi
   thêm tool mới cho cả hai runtime. Đo bằng số lần phải sửa `normalizedTool`.
4. **Agent built-in nào được cấp subagent, và có nên cấp không.** Trần §5.5 đã khoá `subagents: []`
   cho custom agent, nhưng `main` thì đã delegate được sang 7 Agent — subagent riêng cho nó là thêm
   năng lực hay thêm một đường trùng lặp không trace được, chưa trả lời bằng lập luận được. Đo bằng
   §10.3 tầng 2: in chi phí context và token của cả hai đường rồi so.
