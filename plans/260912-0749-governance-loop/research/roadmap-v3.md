# ALP — Roadmap cập nhật kiến trúc (V3)

**Chủ đề:** đóng vòng governance cho delegation — *giao việc có phạm vi → chạy dưới enforcement đo được → bằng chứng có nguồn gốc → chấp nhận có thẩm quyền* — trên kernel hiện có của `alp-code`, không tái cấu trúc.

**Trạng thái:** draft để review. Viết dựa trên code tại `main` (v0.14.0, commit `ffa9706`, 2026-09-12).

**Khác V2 ở đâu (tóm tắt, chi tiết ở §12):** đảo thứ tự ưu tiên (telemetry rời khỏi P0 vì không chặn vòng governance); mỗi contract mới có *producer* và *consumer* cụ thể trong cùng phase; tool trace tận dụng `HistoryBridge` đã có thay vì làm mới; budget "hard" tách thành ADR riêng vì nó là đảo ngược quyết định bỏ `PreToolUse` hook; acceptance có CLI sinh ra nó và có guard chống tự chấp nhận; `verify.commands` lên sớm (Phase 3) vì không có nó thì "verified" chỉ là self-report; provider capability phải ghi `measuredOn`; dùng đúng quy ước `version: 1` / hậu tố `V1` của repo.

---

## 0. Đọc nhanh

| Phase | Tên | Trả lời câu hỏi | Ước lượng |
|---|---|---|---|
| 1 | Approval hẹp (M3) | "Principal có được hỏi trước khi ALP cấp một quyền ngoài mặc định không?" | 3–4 ngày |
| 2 | `writeScope` | "Child được ghi *ở đâu* trong workspace?" | 3–5 ngày |
| 3 | Evidence | "Child đã làm gì — theo ai nói?" | 6–8 ngày |
| 4 | Acceptance | "Ai chấp nhận kết quả đó, dựa trên gì?" | 4–6 ngày |
| 5 | Runtime enforcement capabilities | "Enforcement mà evidence dựa vào có thật trên máy này không?" | 2–3 ngày |
| 6 | Usage telemetry + budget (observe-only) | "Tốn bao nhiêu, và vượt ngưỡng khai báo chưa?" | 4–5 ngày |
| 7 | Launch provenance | "Process này đã được phóng bằng gì, xác thực kiểu nào?" | 1–2 ngày |

Tổng ≈ 5–7 tuần nếu chạy tuần tự; Phase 1, 5, 7 độc lập và có thể xen kẽ. Tốc độ tham chiếu: execution graph (5 phase) và Thread (6 phase) mỗi cái ≈ 1 tuần.

**Vòng governance đóng sau Phase 4.** **Gate `orchestrator` (vision §5.9) mở sau Phase 6** — không đợi Supervisor.

---

## 1. Mục tiêu và phi mục tiêu

### Mục tiêu

1. Một delegation có thể **khai báo** phạm vi ghi và bằng chứng yêu cầu; ALP **cưỡng chế** phần cưỡng chế được và **ghi rõ** phần không.
2. Kết quả child có **bằng chứng có nguồn gốc** (`observed | derived | self-reported | unknown`), không trộn lẫn "agent nói" với "ALP thấy".
3. Cha **chấp nhận/từ chối** kết quả bằng một hành động được xác thực, và quyết định đó đi vào Thread context có kiểm soát.
4. Principal được **hỏi** ở những quyết định policy không nên tự động — hẹp, prepare-time, không per-tool-call.
5. Mọi contract mới có `version: 1`, có producer, có consumer, có test, trong cùng một phase.

### Phi mục tiêu (đẩy ra ngoài roadmap này)

- **Supervisor / policy pack / workspace governance** (V2 P3) — chưa có primitive thật để đặt vào (vision §9).
- **M1 (surface/UI), M4** — không nhắc trong V2, không kéo vào đây.
- **Resume runtime session** — vi phạm bất biến "`thread continue` = execution mới".
- **`AssignmentContract` / `LaunchContract` / `assignmentId` / lease riêng** — đã bỏ từ V2, giữ nguyên quyết định.
- **Budget "hard" (chặn tool call giữa chừng)** — cần ADR riêng, xem §9.
- **Đổi ExecutionGraph thành DAG; >1 active root/Thread; steer message vào process** — ngoài phạm vi từ plan Thread, giữ nguyên.
- **Markdown làm nguồn config** — vision decision #1 đã bác.

---

## 2. Bất biến giữ nguyên (không phase nào được chạm)

1. **Identity là code.** Definition frozen, hash vào `definitionHash`; thêm field vào `ExecutionPolicy` nghĩa là field đó vào `policyHash`.
2. **ALP quyết ai giao cho ai.** `PolicyEngine.authorize()` và `ExecutionService.authorize()` không đọc Thread, không đọc evidence, không đọc acceptance.
3. **Fail-closed.** Không đo được ⇒ `unknown`, không ⇒ "ok". Không có surface để hỏi ⇒ `deny`, không ⇒ `allow`.
4. **Thread ≠ Execution ≠ Graph ≠ Process.** Thread chỉ index root; child đi qua graph; acceptance không làm Thread thành authority unit.
5. **Không hai nguồn truth cho một lifecycle.** Acceptance là *một record thêm vào* node đã settled, không phải một trạng thái lifecycle mới.
6. **Không nest lease** (Thread lease ↔ Graph lease). Verify command và git diff chạy **ngoài** cả hai lease.
7. **Context là untrusted model input.** Evidence và acceptance render vào context như dữ liệu; policy không đọc từ context.
8. **Không fabricate.** Bridge partial khai `partial`; evidence thiếu khai `unknown`; usage không đo được khai `completeness`.
9. **Runtime = f(model)** qua `MODEL_RUNTIMES`; không phase nào thêm cách chọn runtime mới.
10. **Không thư mục mới nếu không có primitive mới thật sự** (vision §9). Danh sách file mới ở §10.

---

## 3. Đã có sẵn — không làm lại

Phần này để reviewer đối chiếu: V1 đề xuất ~1/3 những thứ này; V2 đã bỏ phần trùng, V3 chỉ liệt kê để mỗi phase sau chỉ nói *delta*.

| Năng lực | Ở đâu | Ghi chú cho các phase sau |
|---|---|---|
| Launch pinning | `src/execution/types.ts` `ExecutionPolicy`: `thread`, `role`, `workspace`, `workspaceMode`, `mode`, `model`, `reasoningEffort`, `runtime`, `workspaceAccess`, `allowedTools`, `skills`, `skillRoots`, `subagents`, `mcpServers`, `autoCompactTokens`, `memory`, `delegatesTo`, `definitionHash`, `policyHash` | Phase 2 thêm `writeScope`, Phase 5 thêm `enforcement`. Key bắt buộc, `null` khi không có (vì `canonicalize()` bỏ `undefined`). |
| Authorize trước, materialize sau | `ExecutionAuthorization` (vé), `materialize()` chỉ nhận vé | Phase 1 chèn approval **vào** `authorize()`, trước khi vé ra đời. |
| Graph: node bất biến, fingerprint, hạn mức, reservation, cascade cancel | `src/execution/graph/` — `ChildRequest` (`execution-graph-service.ts:153`), `requestFingerprint` (`:223`) hash `parentExecutionId, agentId, task, workspace, workspaceMode, mode, background, interactive, timeoutMs` | Phase 2 **thêm** `writeScope` vào fingerprint. Phase 4/6 thêm field optional vào node. |
| `alp delegate` xác thực cha qua env + `graph.authenticateParent` | `src/cli/commands/delegate.ts:300` `readBindingFromEnvironment(env)` | Phase 4 tái dùng cho `accept|reject`. |
| Native delegation bị chặn | `src/runtime/permission-rules.ts`: `deny.push("Task")`, deny `Agent` khi `subagents.length === 0`; Codex `[[rules]]` deny `herdr`/`paseo` | V1 P1 "disable native delegation" — đã xong. |
| Runtime ACL declarative | `permission-rules.ts`: Claude allow/deny theo `TOOL_CATALOG`; Codex `approval_policy = "never"`, `writable_roots = [workspace, memory/private/<role>]`, `network_access` từ WebFetch/WebSearch | Phase 2 đổi `writable_roots`; Phase 5 đưa `enforcementNotes` (đang ở `permission-rules.ts` + `agent-test/tier2.ts`) thành bảng có `measuredOn`. |
| Sandbox Claude cho read-only | `claude-adapter.ts:125-130` `sandbox.filesystem.denyWrite: [activeWorkspace]`, tắt trên Windows (`sandboxAvailable()`) | Phase 2 cần đo precedence `allowWrite`/`denyWrite`. |
| Thread: root-only, `settleRoot` → `projectContext`, projector chỉ đọc pins | `src/thread/thread-service.ts:223, :453`; `context-projector.ts` lọc `pin.source !== THREAD_SEED_PIN_SOURCE` | Phase 4 thêm nguồn thứ hai cho projector. |
| HistoryBridge (Claude/Codex) đọc transcript qua `runtime-session.json`, cursor + `id` idempotent, completeness `complete\|partial\|final-only\|unsupported` | `src/thread/history-bridge.ts`, `thread-service.ts:311 collectHistory` | Phase 3 chạy bridge cho **child**; Phase 6 đọc usage từ **cùng transcript** đó. |
| Tool trace post-hoc cho root | `history-types.ts`: `ThreadToolCallRef { name, callId, summary, isError, artifact }`, `ThreadChangeRef { workspace, paths, commit, artifact }`, `ThreadExecutionBoundary` | V2 "tool trace" — nửa đã có. Gap thật = child. |
| Mode tách model khỏi role; `.alp/settings.json` 3 tầng | `src/agents/modes.ts`, `src/cli/settings.ts` `loadModeProfiles` | Phase 3 thêm khối `verify` vào cùng file settings, cùng cơ chế 3 tầng. |
| `alp agent test` tầng 1–3, `alp doctor`, `alp delegation tree --json`, `alp context pin|unpin|status|validate`, `alp thread show|continue` | `src/cli/commands/*`, `src/install/doctor.ts` | Consumer có sẵn cho Phase 3–7. |
| E2E với fake `claude`/`codex` binary | `test/e2e/harness.ts` | Mọi phase dùng pattern này. |

**Không có** ở bất kỳ đâu trong `src/`: token/usage telemetry (grep `usage` chỉ trúng text CLI); `require_approval`; writeScope; evidence; acceptance; runtime capability có `measuredOn`; launch provenance.

---

## 4. Khoảng trống thật (cái roadmap này lấp)

1. **Child là hộp đen sau khi settle.** `DelegationService.wait()` (`delegation-service.ts:439`) đọc `state.json.output` — hoàn toàn self-reported. Không có tool trace, không có git diff cho child.
2. **Không phân biệt "agent nói đã test" với "ALP thấy test pass".**
3. **Cha không có hành động "chấp nhận".** Kết quả child trôi thẳng vào turn tiếp theo của cha; Thread context không biết delegation nào đã được duyệt.
4. **`workspace-write` là cả cây.** Child review một module vẫn ghi được cả repo; hai child song song cùng workspace không tách được diff của nhau.
5. **Enforcement không tự mô tả.** Codex không cưỡng chế tool grant và read isolation (đo 2026-09-10); Windows không có sandbox — nhưng chỉ ghi trong `enforcementNotes` text, không phải dữ liệu mà evidence đọc được.
6. **Không có cửa hỏi principal.** `PolicyDecision` hiện chỉ `allow | deny`.
7. **Không biết tốn bao nhiêu.**

---

## 5. Quy ước chung cho mọi contract mới

- **Version:** field `version: 1` literal + type hậu tố `V1` (`ThreadDocumentV1`, entries `version: 1`). Thêm field *optional* vào document đã có → **không** bump version, ghi chú "additive" trong docblock. Đổi nghĩa field hoặc thêm field bắt buộc → bump.
- **Key bắt buộc, `null` khi vắng** cho mọi field đi vào hash (`canonicalize()` bỏ `undefined`).
- **Provenance** là enum đóng: `observed | derived | self-reported | unknown`. `source` là enum đóng: `git | history-bridge | alp-verifier | agent-output | runtime-event`.
- **Nơi lưu:** dưới thư mục execution (`<execution>/…`) cho thứ thuộc một execution; graph node chỉ giữ **digest + tóm tắt** để `alp delegation tree` đọc không cần mở từng thư mục; Thread chỉ giữ thứ đã đi qua `projectContext`.
- **Không secret trong bất kỳ record mới nào** — tái dùng `history-redact.ts` cho mọi text lấy từ transcript/tool output.
- **Docblock tiếng Việt**, giải thích *vì sao* như code hiện có.

---

## 6. Các phase

### Phase 1 — Approval hẹp (M3, prepare-time)

**Mục tiêu.** `PolicyDecision` có nhánh thứ ba; chỉ **một** surface hỏi được (`alp` root TTY); mọi surface khác ⇒ `deny`.

**Contract.**
```ts
// src/policy/types.ts
export type PolicyDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly code: PolicyErrorCode; readonly reason: string }
  | { readonly kind: "require_approval"; readonly rule: ApprovalRuleId;
      readonly prompt: string; readonly scope: "once" | "execution" | "session" };

// src/execution/types.ts — vào ExecutionPolicy, vào policyHash
readonly approvals: readonly ApprovalRecordV1[];   // [] khi không có
export interface ApprovalRecordV1 {
  readonly version: 1;
  readonly rule: ApprovalRuleId;
  readonly scope: "once" | "execution" | "session";
  readonly decidedBy: "principal";
  readonly decidedAt: string;
}
```
- `Authorization` hiện tại (`allowed: true | false`) giữ nguyên làm kết quả *cuối*; `PolicyDecision` là bước trung gian trong `ExecutionService.authorize()`: `require_approval` + surface trả lời "yes" ⇒ `allowed: true` + record; "no" hoặc không có surface ⇒ `allowed: false`, code mới `APPROVAL_DENIED` / `APPROVAL_UNAVAILABLE`.
- `supportsApproval` là thuộc tính của **surface** (`runMainSession` / `alp` root, `interactive === true`), **không** phải của runtime adapter. `alp delegate` chạy dưới tool call của model — stdout về model, không có principal — ⇒ luôn `deny`. Background/specialist ⇒ `deny` (đúng vision).
- `scope: session` = trong đời **root execution** hiện tại (không có khái niệm session nào khác); lưu ở `<root execution>/context/approvals.json`, chỉ root đọc. `execution` = execution đang authorize. `once` = không lưu.

**Rule áp dụng ở phase này (đủ hẹp để có giá trị thật, không hơn).**
1. `--workspace` ngoài các root đã grant nhưng nằm **trong** project root hiện tại → hỏi thay vì `WORKSPACE_NOT_GRANTED`.
2. `--mode ultra` (hoặc nấc mà settings đánh dấu `requiresApproval: true`) → hỏi một lần/session.

Không hỏi cho: tool grant, delegation target, memory — những thứ này là identity, giữ `deny`.

**Consumer.** `alp thread show` / `alp delegation tree` hiển thị `approvals` của policy. `alp agent test` tầng 1 kiểm rule "không có surface ⇒ deny".

**Test.** Unit: engine trả `require_approval` đúng rule; `authorize()` với surface giả yes/no/absent; `policyHash` đổi khi `approvals` đổi. E2E: `alp delegate` từ child chạm rule ⇒ `APPROVAL_UNAVAILABLE`, không spawn.

**DoD.** Hai rule chạy thật trên `alp` TTY; child không bao giờ thấy prompt; record vào policy.json; docs §M3 trong vision cập nhật "đã có, phạm vi hẹp".

---

### Phase 2 — `writeScope`

**Mục tiêu.** Child `workspace-write` khai được *tập đường dẫn* nó được ghi; ALP cưỡng chế được trên cả hai runtime ở mức runtime cho phép, và **ghi rõ** mức đó.

**Contract.**
```ts
// ChildRequest / DelegationRequestInput
readonly writeScope?: readonly string[];      // relative to workspace; canonicalize, phải nằm trong workspace
// ExecutionPolicy (vào policyHash)
readonly writeScope: readonly string[] | null; // null = toàn workspace (giữ hành vi cũ)
```
- Chỉ hợp lệ khi `workspaceMode === "workspace-write"`; có `writeScope` + `read-only` ⇒ lỗi `WRITE_SCOPE_ON_READ_ONLY` ở authorize.
- **Thêm** `writeScope` vào `requestFingerprint` (cùng task/workspace/mode/background/interactive/timeoutMs — không viết lại danh sách).
- CLI: `alp delegate --write-scope <path>` lặp được.
- Child **kế thừa hẹp hơn**: child của child chỉ được `writeScope ⊆` của cha (kiểm ở `PolicyEngine` như depth/workspace hiện nay).

**Enforcement.**
- Codex: `[sandbox_workspace_write] writable_roots = [...writeScope.map(abs), memory/private/<role>]` thay cho `policy.workspace`. Đã đo Codex cưỡng chế write ⇒ `observed`.
- Claude: hai cách, chọn sau khi đo ở Phase 2 (task đầu tiên của phase):
  - (a) `sandbox.filesystem.allowWrite: writeScope` + `denyWrite: [workspace]` — nếu precedence allow-over-deny đúng như tài liệu;
  - (b) permission rules `deny: Write(<workspace>/**), Edit(<workspace>/**)` + `allow: Write(<scope>/**), Edit(<scope>/**)` — không phụ thuộc sandbox, nhưng không chặn Bash ghi file.
  - Windows: không sandbox ⇒ (b) hoặc `declared-only`; `enforcementNotes` phải nói ra.
- Kết quả đo ghi thẳng vào bảng capability của Phase 5 (Phase 2 tạo bảng ở dạng tối thiểu, Phase 5 hoàn thiện).

**Consumer.** Phase 3 dùng `writeScope` để phân loại change `inScope | outsideScope` và để tách diff giữa sibling. `alp delegation tree` hiển thị scope.

**Test.** Unit: canonicalize + reject path ngoài workspace, `..`, symlink ra ngoài; fingerprint đổi khi scope đổi; hash đổi. Adapter: config.toml / settings.json sinh đúng. E2E fake binary: đọc lại config được phát, assert `writable_roots`.

**DoD.** `alp delegate --write-scope src/foo` ⇒ Codex không ghi được ngoài `src/foo` (test thật một lần trên máy dev, ghi vào measuredOn); Claude theo phương án đã đo; policy.json có `writeScope`.

---

### Phase 3 — Evidence

**Mục tiêu.** Sau khi child settle, ALP có một `ExecutionEvidenceV1` với từng item ghi rõ *nguồn* và *nguồn gốc*; `requiredEvidence` khai trong request được đánh giá `satisfied | unsatisfied | unknown`.

**Contract.**
```ts
// src/execution/evidence.ts (file mới, cùng thư mục — không thư mục mới)
export interface ExecutionEvidenceV1 {
  readonly version: 1;
  readonly executionId: string;
  readonly requestId: string | null;          // null cho root
  readonly collectedAt: string;
  readonly completeness: HistoryCompleteness; // tái dùng của bridge
  readonly items: readonly EvidenceItemV1[];
  readonly digest: string;                    // sha256 canonical(items)
}
export type EvidenceItemV1 =
  | { kind: "tool-call"; provenance; source: "history-bridge"; ref: ThreadToolCallRef }
  | { kind: "change"; provenance; source: "git" | "history-bridge";
      paths: readonly string[]; commit: string | null; outsideScope: readonly string[];
      ambiguousWith: readonly string[] }      // sibling executionIds ghi cùng workspace, cùng khoảng thời gian
  | { kind: "verify"; provenance: "observed"; source: "alp-verifier";
      commandId: string; exitCode: number; durationMs: number; tail: string }
  | { kind: "output"; provenance: "self-reported"; source: "agent-output"; digest: string }
  | { kind: "boundary"; provenance: "observed"; source: "runtime-event"; ref: ThreadExecutionBoundary };
```
- `provenance` quy tắc cứng: `git` ⇒ `observed` nếu `ambiguousWith.length === 0`, ngược lại `derived`; `history-bridge` ⇒ `observed` khi completeness `complete`, `derived` khi `partial`; `agent-output` ⇒ luôn `self-reported`; bridge `unsupported` ⇒ item `unknown`.

**Producer.**
1. **Git baseline** tại `materialize()` của child `workspace-write`: `git rev-parse HEAD` + digest `git status --porcelain` → `<execution>/context/baseline.json`. Tại settle: diff so với baseline → item `change`. Sibling overlap tính từ graph (`startedAt/finishedAt`, cùng `workspace`, `workspace-write`); nếu cả hai có `writeScope` rời nhau ⇒ vẫn `observed`.
2. **HistoryBridge cho child**: `DelegationService.wait()`/reconcile gọi `bridge.collectDelta` trên child, ghi vào `<child execution>/context/history/` (không vào Thread `messages/` — Thread vẫn root-only). Items `tool-call` + `boundary`.
3. **`alp-verifier`**: đọc `.alp/settings.json` khối mới, cùng cơ chế 3 tầng của `loadModeProfiles`:
   ```json
   { "verify": { "commands": [ { "id": "test", "run": "npm test", "timeoutMs": 600000, "cwd": "." } ] } }
   ```
   Chạy **sau** settle, **ngoài** lease, trong workspace của child, env tối thiểu, không shell login. Kết quả ⇒ item `verify`. Rủi ro: repo config chạy lệnh — chấp nhận vì agent đã chạy lệnh trong repo đó; nhưng chỉ lấy `verify` từ tầng project trở lên, không từ tầng user-global (ghi rõ trong docs).
4. **`state.json.output`** ⇒ item `output` self-reported.

**`requiredEvidence`.**
```ts
// ChildRequest / DelegationRequestInput
readonly requiredEvidence?: readonly ("change" | `verify:${string}`)[];
// DelegationResult
readonly evidence: { digest: string; evaluation: "satisfied" | "unsatisfied" | "unknown";
                     missing: readonly string[] } | null;
```
Đánh giá: mọi mục có item `observed`/`derived` tương ứng ⇒ `satisfied`; có mục vắng ⇒ `unsatisfied`; evidence `unknown` ở mục đó ⇒ `unknown`. `self-reported` **không** thoả mãn bất kỳ mục nào.

**Consumer.** `wait()` trả `evidence`; `alp delegation tree --json` có `evidence.digest/evaluation`; `alp delegation evidence <requestId>` in đầy đủ (mới, read-only, không cần binding).

**Test.** Unit: quy tắc provenance; overlap sibling; evaluator. Service: git repo tạm, hai child song song cùng workspace ⇒ `ambiguousWith`; verify command fail ⇒ `unsatisfied`. E2E fake binary ghi file + transcript giả ⇒ evidence có `tool-call` + `change`; bridge `unsupported` ⇒ `unknown`, không throw.

**DoD.** Một delegation thật với `--require-evidence verify:test` trả `unsatisfied` khi test fail, `satisfied` khi pass; evidence.json tồn tại cho mọi child settled; Thread `messages/` không đổi.

---

### Phase 4 — Acceptance

**Mục tiêu.** Cha chấp nhận/từ chối kết quả child bằng hành động xác thực; quyết định đó tới Thread context qua `projectContext` như **nguồn thứ hai**, không phải pin.

**Contract.**
```ts
// src/execution/acceptance.ts (file mới, cùng thư mục với graph — quyết định là của cây)
export interface AcceptanceRecordV1 {
  readonly version: 1;
  readonly requestId: string;
  readonly subjectExecutionId: string;
  readonly acceptedByExecutionId: string;     // phải là parentExecutionId của subject
  readonly decision: "accepted" | "rejected";
  readonly evidenceDigest: string;            // digest tại thời điểm quyết — evidence đổi sau đó thì record lệch, thấy được
  readonly reasons: readonly string[];        // text của cha; redact
  readonly decidedAt: string;
}
```
- Lưu `<parent execution>/acceptance/<requestId>.json`; graph node subject nhận field optional `acceptance: { decision, evidenceDigest, decidedAt } | null` (additive, `version: 1` giữ nguyên, `revision + 1`).
- **Guard:** `acceptedByExecutionId === node.parentExecutionId`, xác thực bằng `graph.authenticateParent` từ `readBindingFromEnvironment` — cùng cửa `alp delegate` đi qua. Root không có cha ⇒ không ai accept root (root settle qua Thread như hiện nay). Mỗi requestId quyết **một lần**; lần hai ⇒ `ACCEPTANCE_ALREADY_DECIDED`.
- Node chưa settled ⇒ `ACCEPTANCE_SUBJECT_RUNNING`. Không có evidence (Phase 3 chưa chạy xong cho node) ⇒ vẫn cho quyết, `evidenceDigest` là digest của evidence rỗng — record tự nói "quyết khi chưa có bằng chứng".

**Producer.** `alp delegation accept <requestId> [--reason …]` / `alp delegation reject <requestId> --reason …`. Thêm vào `TOOL_CATALOG` cho role có `delegatesTo` (cùng chỗ `delegatesViaBash` cho phép `alp delegate`). Instruction của `main` cập nhật: sau `wait`, đọc evidence, gọi accept/reject.

**Consumer.**
1. `settleRoot` ghi vào boundary số child `accepted / rejected / undecided` (observe; **không** chặn settle ở phase này — gate chặn để cho orchestrator §7).
2. `projectContext` nhận `acceptances` (đọc từ graph của root vừa settle) và ghi vào checkpoint một section **do ALP sinh**, tách khỏi pins:
   ```ts
   // context-types.ts — ThreadContextCheckpoint, additive
   readonly delegations: readonly { requestId; target: AgentId; task: string /* cắt */;
                                    decision: "accepted" | "rejected" | "undecided"; evidenceDigest }[];
   ```
   Giới hạn N mục gần nhất (mặc định 20), render trong handoff dưới heading riêng "Delegations of E-n". **Quyết định:** không dùng pin vì pin là *agent-authored*; acceptance là *ALP-authored* từ record xác thực — trộn hai thứ vào một danh sách là mất provenance ngay ở lớp context.
3. `alp thread show` hiển thị section này; `alp delegation tree` hiển thị `decision`.

**Test.** Unit: guard cha-của-subject (sibling, ông, chính nó ⇒ từ chối); một lần; subject running. Service: accept ⇒ graph revision +1, node có `acceptance`; `projectContext` sinh `delegations` đúng thứ tự, cắt N. E2E: child spawn → settle → `alp delegation accept` với env binding của cha ⇒ ok; với env binding khác ⇒ `GRAPH_PARENT_AUTH_FAILED` (mã hiện có).

**DoD.** `main` thật chạy một vòng delegate → wait → accept; `alp thread continue` thấy "Delegations of E-1" trong handoff; policy engine không có import nào từ `acceptance.ts` (kiểm bằng test import-graph đơn giản).

---

### Phase 5 — Runtime enforcement capabilities

**Mục tiêu.** Biến `enforcementNotes` (text) thành dữ liệu có `measuredOn`; policy.json ghi enforcement đã dựa vào; `alp agent test` tầng 2 phát hiện drift.

**Contract.**
```ts
// src/runtime/capabilities.ts (file mới)
export type EnforcementLevel = "enforced" | "declared-only" | "none";
export interface RuntimeEnforcementCapabilitiesV1 {
  readonly version: 1;
  readonly runtime: RuntimeId;
  readonly measuredOn: { readonly platform: NodeJS.Platform; readonly runtimeVersion: string;
                         readonly measuredAt: string };
  readonly toolGrant: EnforcementLevel;
  readonly readIsolation: EnforcementLevel;
  readonly writeIsolation: EnforcementLevel;
  readonly writeScope: EnforcementLevel;      // từ Phase 2
  readonly networkEgress: EnforcementLevel;
  readonly nativeDelegationDeny: EnforcementLevel;
}
// ExecutionPolicy (vào policyHash)
readonly enforcement: RuntimeEnforcementCapabilitiesV1;
```
- Bảng built-in theo `(runtime, platform)` với số liệu đã đo: Codex 2026-09-10 `toolGrant: declared-only`, `readIsolation: none`, `writeIsolation: enforced`, `networkEgress: enforced`; Claude darwin/linux `writeIsolation: enforced` (sandbox), win32 `none`; v.v.
- Tại launch: adapter đối chiếu `runtimeVersion` thật với `measuredOn.runtimeVersion`; khác ⇒ **vẫn chạy** nhưng ghi `enforcement.measuredOn` như bảng và `alp doctor` cảnh báo "capability chưa đo lại cho version này". Không fail-closed ở đây vì đó là chặn toàn bộ ALP mỗi khi CLI update; thay vào đó evidence của Phase 3 hạ `observed` → `derived` khi version lệch (quy tắc thêm vào evaluator).
- `enforcementNotes` hiện có được **sinh** từ bảng này, không viết tay nữa.

**Consumer.** `alp agent test` tầng 2 chạy probe thật (ghi file ngoài scope, gọi tool không grant) và so với bảng ⇒ `DRIFT`. `alp doctor` in bảng cho máy hiện tại. Phase 3 evaluator đọc `policy.enforcement`.

**Test.** Unit: bảng có đủ mọi `(runtime, platform)`; policyHash đổi khi enforcement đổi. Agent test tầng 2 với fake binary giả lập drift.

**DoD.** Chạy `alp agent test` trên darwin với Claude + Codex thật, không `DRIFT`; policy.json có `enforcement`; docs `delegation.md` có bảng.

---

### Phase 6 — Usage telemetry + budget observe-only

**Mục tiêu.** Biết mỗi execution tốn bao nhiêu token / bao nhiêu tool call; child khai `budget` được đánh giá **sau** khi chạy; không chặn giữa chừng.

**Nguồn dữ liệu (sửa lại nhận định ở review V2).** Không cần đổi cách phóng child. Cả hai runtime để usage trong **cùng transcript** mà `HistoryBridge` đã mở qua `runtime-session.json`: Claude JSONL có `message.usage` trên mỗi assistant entry; Codex rollout có event `token_count`. ⇒ root interactive **cũng đo được** post-hoc, với completeness của bridge. Việc đầu tiên của phase: xác nhận hai định dạng này trên version đang dùng và ghi vào `measuredOn`.

**Contract.**
```ts
// src/execution/usage.ts (file mới)
export interface ExecutionUsageV1 {
  readonly version: 1;
  readonly executionId: string;
  readonly source: "history-bridge";
  readonly completeness: HistoryCompleteness;
  readonly inputTokens: number | null; readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null; readonly cacheWriteTokens: number | null;
  readonly toolCalls: number | null;
  readonly collectedAt: string;
}
// ChildRequest / DelegationRequestInput
readonly budget?: { readonly tokens?: number; readonly toolCalls?: number };  // vào fingerprint
// DelegationResult
readonly usage: ExecutionUsageV1 | null;
readonly budgetStatus: "within" | "exceeded" | "unknown";
```
- Lưu `<execution>/usage.json`; graph node có `usage: { inputTokens, outputTokens, toolCalls } | null` (additive) để `alp delegation tree` tính tổng theo cây không mở file.
- `budgetStatus`: `exceeded` là **evidence**, không phải lỗi; đi vào `EvidenceItemV1` như item `boundary` mở rộng để Phase 4 accept/reject thấy.

**Consumer.** `alp delegation tree --json` có usage từng node + tổng; `alp thread show` có tổng theo execution; `wait()` trả `budgetStatus`.

**Test.** Unit: parser usage cho hai định dạng (fixture transcript thật, redact); tổng theo cây; `unknown` khi bridge `unsupported`. E2E: fake binary ghi transcript có usage ⇒ tree tổng đúng.

**DoD.** `alp delegation tree` in token/tool-call cho mọi node; `--budget-tokens` trên `alp delegate` ⇒ `exceeded` đúng; không có hook mới nào được thêm.

---

### Phase 7 — Launch provenance

**Mục tiêu.** Mỗi process có một receipt: chạy bằng CLI version nào, xác thực kiểu nào, spec digest gì.

**Contract.**
```ts
// src/runtime/launch-provenance.ts (file mới)
export interface LaunchProvenanceV1 {
  readonly version: 1;
  readonly executionId: string;
  readonly runtime: RuntimeId; readonly runtimeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly authMethod: "oauth" | "api-key" | "unknown";   // suy từ env/config, không đọc secret
  readonly credentialConfigured: boolean;
  readonly launchSpecDigest: string;                      // sha256 canonical(RuntimeLaunchSpec minus env values)
  readonly launchedAt: string;
}
```
- Ghi `<execution>/runtime/launch.json` **sau** policy (không vào hash — nó là sự kiện, không phải quyết định). Backend ghi ngay trước `spawn`.

**Consumer.** `alp doctor` (auth trạng thái), `alp thread show` (runtime version của từng E-n), evidence `boundary` tham chiếu digest.

**Test.** Unit: digest ổn định, không chứa giá trị env; `authMethod` suy đúng từ fixture env. E2E: file tồn tại cho root và child.

**DoD.** Receipt cho mọi execution; `alp doctor` in `authMethod` cho hai runtime.

---

## 7. Gates

| Gate | Điều kiện | Mở gì |
|---|---|---|
| **Governance loop đóng** | Phase 2 + 3 + 4 xong; `main` chạy một vòng delegate → wait → evidence → accept trên cả hai runtime | Cho phép nói "delegation có kiểm chứng" trong README/docs |
| **`orchestrator` (vision §5.9)** | Governance loop + Phase 5 + Phase 6 (observe-only đủ; không cần hard budget) | Bắt đầu plan cho role `orchestrator` — role điều phối nhiều child và **bắt buộc** accept/reject trước khi settle root (chỗ duy nhất "chặn settle khi còn `undecided`" được bật) |
| **Hard budget** | ADR riêng (§9) được duyệt | Phase 6b |
| **Supervisor / policy pack** | Có ≥2 project dùng governance loop thật với nhu cầu khác nhau | Roadmap kế tiếp |

---

## 8. Chiến lược test

- **Unit** cho mọi contract mới: version literal, canonicalize/hash ổn định, key bắt buộc `null`.
- **Service** với `in-memory` store (thread) và graph store tạm: mọi guard fail-closed có test tiêu cực.
- **E2E** theo `test/e2e/harness.ts`: fake `claude`/`codex` ghi transcript giả (có usage, có tool call), ghi file trong/ngoài scope, đọc lại config được phát để assert enforcement config. Mỗi phase thêm ≥1 file `test/e2e/<phase>.test.ts`.
- **Đo thật một lần/phase** trên máy dev với CLI thật cho những gì phụ thuộc runtime (Phase 2 precedence sandbox, Phase 5 bảng, Phase 6 định dạng usage) — kết quả ghi vào `measuredOn`, không ghi vào test tự động.
- **Import-graph test**: `src/policy/**` không import `evidence|acceptance|usage|thread` — bảo vệ bất biến #2 bằng test thay vì bằng review.

---

## 9. Quyết định mở cần ADR riêng (không chặn roadmap)

1. **Hard budget / per-call enforcement.** Muốn chặn tool call thứ N+1 phải có lại `PreToolUse` hook — thứ đã bỏ có chủ đích khi chuyển sang ACL declarative (mất `hasIndirectCommand`, workflow-state gating cùng lúc). Đây là đảo ngược quyết định kiến trúc; cần ADR nêu: chi phí latency/độ ổn định hook, Codex không có hook tương đương ⇒ bất đối xứng, và giá trị thật so với observe-only + reject.
2. **Approval "đi lên theo cây" cho child.** Phase 1 cố ý `deny` ở child. Nếu cần child xin phép principal thì cần kênh ngoài stdout (graph node `pending-approval` + root TTY poll) — đó là M3 đầy đủ, ADR riêng.
3. **`verify.commands` từ tầng nào.** Phase 3 chọn project trở lên; nếu có nhu cầu user-global (ví dụ lint chung) thì cần ADR về trust boundary.

---

## 10. File mới / file sửa (đối chiếu vision §9)

Không thư mục mới.

| Mới | Sửa chính |
|---|---|
| `src/execution/evidence.ts`, `src/execution/acceptance.ts`, `src/execution/usage.ts` | `src/execution/types.ts` (ExecutionPolicy +`approvals`, `writeScope`, `enforcement`), `src/execution/graph/types.ts` (node +`acceptance`, `usage`), `execution-graph-service.ts` (ChildRequest, fingerprint) |
| `src/runtime/capabilities.ts`, `src/runtime/launch-provenance.ts` | `src/runtime/permission-rules.ts` (writeScope, notes sinh từ bảng), `claude-adapter.ts`, `codex-adapter.ts` |
| subcommand `accept\|reject\|evidence` trong `src/cli/commands/delegate.ts` | `src/cli/commands/delegate.ts` (flags), `src/cli/settings.ts` (khối `verify`), `src/policy/types.ts` (`PolicyDecision`), `src/policy/*` engine |
| `test/e2e/write-scope.test.ts`, `evidence.test.ts`, `acceptance.test.ts`, `usage.test.ts`, `approval.test.ts` | `src/thread/thread-service.ts` (`projectContext` nhận acceptances), `context-projector.ts`, `context-types.ts`, `src/delegation/delegation-service.ts` (`wait` trả evidence/usage), `src/agent-test/tier2.ts` |
| `plans/<date>-governance-loop/plan.md` + `phase-N-*.md` | `docs/delegation.md`, `docs/architecture.md`, `docs/alp-design-philosophy-and-vision.md` (§4.10, M3 trạng thái) |

---

## 11. Rủi ro

| Rủi ro | Giảm nhẹ |
|---|---|
| Claude sandbox allow/deny precedence không như kỳ vọng ⇒ writeScope chỉ `declared-only` trên Claude | Phase 2 đo trước khi code; bảng Phase 5 nói thật; evidence hạ về `derived` |
| `verify.commands` chạy lệnh từ repo | Chỉ tầng project trở lên, env tối thiểu, timeout, ghi rõ trong docs |
| Git diff sai khi workspace không phải git repo | Item `change` `unknown`, evaluator trả `unknown`, không throw |
| Thêm 3 field vào `ExecutionPolicy` ⇒ policy.json cũ không đọc được | Reader chấp nhận thiếu key cho snapshot có `version` cũ / tạo trước; writer luôn ghi đủ key. Test cutover trong `test/cutover/` |
| Transcript format Claude/Codex đổi ⇒ usage `unknown` hàng loạt | Đúng hành vi fail-closed; `alp doctor` cảnh báo khi tỷ lệ `unknown` cao |
| `main` không gọi accept/reject | Boundary ghi `undecided`; gate orchestrator mới bắt buộc |

---

## 12. Đã bỏ / đã đổi so với V2

| V2 | V3 | Vì sao |
|---|---|---|
| P0 = approval + token budget + tool-call budget + trace | Approval Phase 1; telemetry Phase 6; trace tách thành "bridge cho child" trong Phase 3 | Telemetry không chặn vòng governance; trace root đã có |
| Tool-call budget "hard" | Observe-only; hard ⇒ ADR §9.1 | Là đảo ngược quyết định bỏ `PreToolUse` hook |
| "Root usage không đo được" (nhận định của em ở review V2) | Đo được post-hoc từ transcript qua bridge | Bridge đã mở đúng file có usage |
| Enrich `ChildRequest` một phase riêng (P1 Phase 4) | Mỗi field đi cùng consumer của nó: `writeScope` (P2), `requiredEvidence` (P3), `budget` (P6); bỏ `stopConditions`, `outputRequirements` | Không thêm field không có consumer; hai field bỏ chưa có cơ chế enforce |
| Acceptance ghi ở `settleRoot`/`projectContext`, không nói ai tạo | `alp delegation accept\|reject` xác thực qua graph binding, guard cha-của-subject | Thiếu producer thì không có record; thiếu guard thì child tự chấp nhận mình |
| `authority: coordinator\|delegate\|internal` | Bỏ | `parentExecutionId` + `delegatesTo` đã trả lời; thêm field là hai nguồn truth |
| `supportsApproval` trên runtime adapter | Trên surface (`runMainSession` interactive) | Runtime không biết có principal ngồi trước hay không |
| `PolicyDecision` thiếu `prompt`/`scope` | Có đủ theo vision M3 | Không có scope thì hỏi mỗi lần hoặc nhớ mãi |
| Provider capability không có ngữ cảnh đo | `measuredOn { platform, runtimeVersion, measuredAt }` | Windows không sandbox; số liệu đo theo version |
| Verify chạy bởi ALP ở P3 | Phase 3 với `verify.commands` trong settings | Không có nó thì "verified" chỉ là self-report |
| `schemaVersion` | `version: 1` + hậu tố `V1` | Quy ước repo |
| §13 vẫn nêu markdown source | Bỏ | Vision decision #1 |
| Không sizing, không test strategy, không M1/M4 | §0, §8, §1 phi mục tiêu | — |
| Module placement liệt kê nhưng không nói file sửa | §10 | Reviewer đối chiếu vision §9 được |
