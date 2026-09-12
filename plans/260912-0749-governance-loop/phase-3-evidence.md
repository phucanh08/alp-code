# P3 — Evidence

<!-- Sửa: rà đối kháng + kiểm chứng lượt 2 (2026-09-12) — điểm kích hoạt collect, verify qua trust, baseline porcelain, overlap gồm ancestor, tách writeIsolation/writeScope, endedAt, commandDigest -->

**Mục tiêu:** sau khi child settle, ALP có `ExecutionEvidenceV1` với từng item ghi *nguồn* và *nguồn gốc*; `requiredEvidence` khai trong request được đánh giá `satisfied | unsatisfied | unknown`.
**Phụ thuộc:** P2 (`writeScope` để phân loại change). P5 nên xong trước để evaluator đọc `policy.enforcement`; nếu chưa, evaluator coi mọi mức là `declared-only`.

---

## Bối cảnh

- `DelegationService.wait()` (`src/delegation/delegation-service.ts:439`) đọc `state.json.output` — self-reported hoàn toàn.
- Child settle qua `reconcileGraph` (probe backend), được gọi từ **mọi** đường đọc: `wait`/`status`/`tree`/`cancel` (`delegation-service.ts:336,480,505,553`). Reconcile là đường đọc, không được kéo theo I/O nặng.
- `HistoryBridge.collectDelta` (`src/thread/history-bridge.ts:50`) đọc transcript qua `runtime-session.json`, cursor + `id` idempotent, không throw. Hiện chỉ `ThreadService.collectHistory` (`thread-service.ts:311`) gọi, cho root. Codex `Stop` có thể thiếu `transcript_path` (`hooks/runtime-session.ts:36`) ⇒ bridge `final-only`/`unsupported` là đường bình thường, không phải lỗi.
- `ThreadToolCallRef`, `ThreadChangeRef`, `ThreadExecutionBoundary`, `HistoryCompleteness` (`src/thread/history-types.ts`) — tái dùng nguyên. `history-redact.ts` — mọi text từ transcript/tool output đi qua đây.
- `.alp/settings.json` 3 tầng qua `loadModeProfiles` (`src/cli/settings.ts:83`) — thêm khối `verify` cùng cơ chế.
- `src/trust/` (`trustAgent`, `TrustedAuthority`, `trusted-agents-store.ts`) — mô hình "principal đã duyệt gì" theo digest; tái dùng cho verify commands.
- Graph node có `startedAt`/`endedAt`, `workspace`, `workspaceMode`, `parentExecutionId` — đủ để tính overlap.
- `main` read-only (`src/agents/main.ts:38 writeRoots: []`) nhưng có Bash; deny-write cho read-only chỉ có sandbox darwin/linux ⇒ root có thể là nguồn ghi đồng thời.

## Thiết kế

### Contract

```ts
// src/execution/evidence.ts
export type Provenance = "observed" | "derived" | "self-reported" | "unknown";
export type EvidenceSource = "git" | "history-bridge" | "alp-verifier" | "agent-output" | "runtime-event";

export interface ExecutionEvidenceV1 {
  readonly version: 1;
  readonly executionId: string;
  readonly requestId: string | null;          // null cho root
  readonly collectedAt: string;
  readonly completeness: HistoryCompleteness;
  readonly items: readonly EvidenceItemV1[];
  readonly digest: string;                    // sha256 canonical(items)
}
export type EvidenceItemV1 =
  | { kind: "tool-call"; provenance; source: "history-bridge"; ref: ThreadToolCallRef }
  | { kind: "change"; provenance; source: "git" | "history-bridge";
      paths: readonly string[]; commit: string | null;
      outsideScope: readonly string[]; outsideScopeVerified: boolean;   // false khi enforcement.writeScope ≠ enforced
      ambiguousWith: readonly string[] }      // executionId của node khác có thể đã ghi cùng workspace trong khoảng đó
  | { kind: "verify"; provenance: "observed"; source: "alp-verifier";
      commandId: string; commandDigest: string; exitCode: number; durationMs: number; tail: string;
      ambiguousWith: readonly string[] }
  | { kind: "verify-skipped"; provenance: "unknown"; source: "alp-verifier";
      commandId: string; reason: "untrusted" | "not-configured" | "timeout" }
  | { kind: "output"; provenance: "self-reported"; source: "agent-output"; digest: string }
  | { kind: "boundary"; provenance: "observed"; source: "runtime-event"; ref: ThreadExecutionBoundary };
```

### Quy tắc provenance (cứng, có test từng dòng)

| Nguồn | Điều kiện | Provenance |
|---|---|---|
| `git` | `ambiguousWith = []` **và** `policy.enforcement.writeIsolation === "enforced"` | `observed` |
| `git` | ngược lại | `derived` |
| `git` | không phải git repo / baseline thiếu | item `unknown` |
| `history-bridge` | completeness `complete` | `observed` |
| `history-bridge` | `partial` / `final-only` | `derived` |
| `history-bridge` | `unsupported` | item `unknown` |
| `agent-output` | luôn | `self-reported` |
| `alp-verifier` (đã chạy), `runtime-event` | luôn | `observed` |
| mọi nguồn | `runtimeVersion` thật lúc launch (P5 `launch.json`) ≠ `policy.enforcement.measuredOn.runtimeVersion` | hạ một bậc: `observed` → `derived` |

Hai câu hỏi, hai field: `writeIsolation` trả lời "child chỉ ghi trong workspace?" ⇒ quyết `observed` cho `change`. `writeScope` trả lời "child chỉ ghi trong scope?" ⇒ quyết `outsideScopeVerified`; `outsideScope = []` với `outsideScopeVerified: false` không phải bằng chứng.

### Overlap (`ambiguousWith`)

Với child C có khoảng `[startedAt, endedAt]`: mọi node N ≠ C trong graph, cùng `workspace`, có khoảng active giao nhau, và **(a)** `N.workspaceMode === "workspace-write"` với `writeScope` không rời `C.writeScope`, **hoặc (b)** `N.policy.enforcement.writeIsolation !== "enforced"` (read-only không sandbox vẫn ghi được qua Bash). Root interactive luôn active suốt đời child ⇒ root read-only có sandbox không vào danh sách; root trên Windows luôn vào.

### Điểm kích hoạt — `collectEvidence(executionId)`

| Gọi từ | Khi | Ghi chú |
|---|---|---|
| `DelegationService.wait()` | ngay sau node terminal | cha đang đợi, chi phí verify chấp nhận được |
| `alp delegation evidence <requestId>` | on-demand | read-only với graph, ghi `evidence.json` nếu chưa có |
| `acceptChild` (P4) | trước khi ghi record nếu chưa có `evidence.json` | record luôn có digest thật |
| **không bao giờ** | `reconcileGraph`, `status`, `tree`, `cancel` | đường đọc không kéo `npm test` |

Idempotent: ghi `<execution>/evidence.json` atomic; gọi lại chỉ bổ sung item còn `unknown` (ví dụ verify chưa chạy vì timeout). Chạy **ngoài** Thread lease và Graph lease.

### Producer

1. **Git baseline** — `materialize()` của child `workspace-write`: `<execution>/context/baseline.json`:
   ```ts
   { version: 1, head: string | null, dirty: readonly { path: string; status: string; contentHash: string | null }[] }
   ```
   Không phải git repo ⇒ `baseline: null`. Sau settle: `paths` = file có status khác baseline **hoặc** `contentHash` khác (file dirty sẵn mà child sửa tiếp) — file dirty sẵn không đổi hash **không** tính cho child. `commit` = HEAD mới nếu đổi. `outsideScope` = `paths ∉ writeScope`.
2. **Bridge cho child** — trong `collectEvidence`, `bridge.collectDelta` trên child, ghi `<child>/context/history/` (cursor + entries), **không** vào Thread `messages/`. Items `tool-call`, `boundary`.
3. **`alp-verifier`** — `.alp/settings.json`:
   ```json
   { "verify": { "commands": [ { "id": "test", "run": "npm test", "timeoutMs": 600000, "cwd": "." } ] } }
   ```
   Chỉ tầng **project trở lên**. **Chỉ chạy khi digest của khối `verify` đã được trust**: `alp trust verify` (cùng `trusted-agents-store.ts`, record `{ project, verifyDigest, trustedAt }`); digest lệch/chưa có ⇒ item `verify-skipped` `untrusted`, in hướng dẫn `alp trust verify`. Lý do: lệnh này chạy bằng process ALP **ngoài** sandbox runtime — không phải "agent đã chạy lệnh trong repo", agent chạy dưới sandbox. Chạy sau settle, ngoài lease, trong workspace child, env tối thiểu (`PATH`, `HOME`), không shell login; timeout ⇒ `verify-skipped` `timeout`. `tail` ≤ 4 KB, redact. `commandDigest` = sha256 của entry lệnh đã chạy. `ambiguousWith` cùng logic overlap tại thời điểm chạy.
4. **`state.json.output`** ⇒ item `output` với digest.

### `requiredEvidence` + evaluator

```ts
// ChildRequest, DelegationRequestInput — vào fingerprint
readonly requiredEvidence?: readonly ("change" | `verify:${string}`)[];
// DelegationResult
readonly evidence: { digest: string; evaluation: "satisfied" | "unsatisfied" | "unknown";
                     missing: readonly string[] } | null;
```

Với mỗi mục: có item `observed | derived` khớp ⇒ đạt; item `unknown`/`verify-skipped` ⇒ mục `unknown`; vắng ⇒ thiếu. Mọi mục đạt ⇒ `satisfied`; có mục thiếu ⇒ `unsatisfied`; còn lại ⇒ `unknown`. `self-reported` **không** đạt mục nào. `verify:<id>` yêu cầu `exitCode === 0`.

CLI: `alp delegate --require-evidence change --require-evidence verify:test`; `alp delegation evidence <requestId>`; `alp trust verify`.

## Việc phải làm

1. Test fail trước: bảng provenance từng dòng; overlap (sibling rời/giao, có/không scope, ancestor read-only có/không sandbox); baseline: file dirty sẵn không đổi ⇒ không tính, dirty sẵn đổi hash ⇒ tính; evaluator; git repo tạm với hai child song song ⇒ `ambiguousWith`; verify chưa trust ⇒ `verify-skipped`, `unknown`; verify fail ⇒ `unsatisfied`; `alp delegation tree` **không** tạo `evidence.json`; bridge `unsupported` ⇒ `unknown` không throw; verify chỉ từ tầng project.
2. `src/execution/evidence.ts`: types, `collectEvidence`, `evaluateEvidence`, bảng provenance, overlap.
3. `src/execution/execution-service.ts`: `materialize` ghi baseline cho child `workspace-write`.
4. `src/delegation/delegation-service.ts`: `wait()` gọi `collectEvidence` sau terminal, trả `evidence`; reconcile không đổi.
5. `src/execution/graph/execution-graph-service.ts`, `types.ts`: `requiredEvidence` vào `ChildRequest` + fingerprint; node `evidence: { digest, evaluation } | null` (additive).
6. `src/cli/settings.ts`: `loadVerifyCommands` (tầng project+) + digest; `src/trust/`: `trustVerify`, `verifyTrusted(project, digest)`; `src/cli/commands/agent-trust.ts` hoặc `trust.ts`: `alp trust verify`.
7. `src/cli/commands/delegate.ts`: flags, subcommand `evidence`.

## File đụng tới

| File | Hành động | Đổi gì |
|---|---|---|
| `src/execution/evidence.ts` | tạo | contract, collector, evaluator, overlap |
| `src/execution/execution-service.ts` | sửa | baseline |
| `src/delegation/delegation-service.ts`, `types.ts` | sửa | collect trong `wait`, result |
| `src/execution/graph/execution-graph-service.ts`, `types.ts` | sửa | `requiredEvidence`, node `evidence` |
| `src/cli/settings.ts`, `src/trust/*`, `src/cli/commands/{delegate,agent-trust}.ts`, `src/cli/alp.ts` | sửa | verify, trust, flags, lệnh |
| `test/execution/evidence.test.ts`, `test/delegation/evidence-collect.test.ts`, `test/trust/verify-trust.test.ts`, `test/e2e/evidence.test.ts` | tạo | |
| `test/e2e/harness.ts` | sửa | fake binary ghi file + transcript có tool call |
| `docs/delegation.md`, `docs/architecture.md` | sửa | evidence, `verify.commands`, `alp trust verify` |

## Rủi ro

| Failure mode | Giảm thiểu |
|---|---|
| Repo lạ mang `.alp/settings.json` có `verify` độc | Không chạy khi chưa `alp trust verify`; digest lệch sau khi trust ⇒ không chạy |
| Verify chạy khi node khác còn ghi ⇒ kết quả nhiễu | `ambiguousWith` trên item `verify`; `alp delegation evidence` in cảnh báo |
| Bridge child đọc transcript ngoài state dir | Guard `realpath` hiện có giữ nguyên |
| `evidence.json` lớn vì tool-call nhiều | `tool-call` chỉ giữ `ThreadToolCallRef`; payload thô ở `context/history/` |
| Crash giữa `collectEvidence` | Atomic write; gọi lại idempotent; thiếu = `unknown` |
| Child background, cha không `wait` | `accept` tự collect (P4); `alp delegation evidence` on-demand |

## Tiêu chí hoàn thành

- `npx vitest run test/execution test/delegation test/trust test/e2e/evidence.test.ts` xanh.
- Delegation thật với `--require-evidence verify:test`: chưa trust ⇒ `unknown` + hướng dẫn; sau `alp trust verify`: test fail ⇒ `unsatisfied`, pass ⇒ `satisfied`.
- `alp delegation tree` trên child đã settle **không** sinh `evidence.json`; `wait` có.
- Thread `messages/` không đổi (assert trong E2E). `npm test` xanh.
