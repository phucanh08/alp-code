# P3 — Evidence

**Mục tiêu:** sau khi child settle, ALP có `ExecutionEvidenceV1` với từng item ghi *nguồn* và *nguồn gốc*; `requiredEvidence` khai trong request được đánh giá `satisfied | unsatisfied | unknown`.
**Phụ thuộc:** P2 (`writeScope` để phân loại change). P5 nên xong trước để evaluator đọc `policy.enforcement`; nếu chưa, evaluator coi enforcement là `declared-only`.

---

## Bối cảnh

- `DelegationService.wait()` (`src/delegation/delegation-service.ts:439`) đọc `state.json.output` — self-reported hoàn toàn.
- `HistoryBridge.collectDelta` (`src/thread/history-bridge.ts:50`) đọc transcript qua `runtime-session.json`, cursor + `id` idempotent, không throw. Hiện chỉ `ThreadService.collectHistory` (`thread-service.ts:311`) gọi, cho root.
- `ThreadToolCallRef`, `ThreadChangeRef`, `ThreadExecutionBoundary`, `HistoryCompleteness` (`src/thread/history-types.ts`) — tái dùng nguyên.
- `history-redact.ts` — mọi text từ transcript/tool output đi qua đây.
- `.alp/settings.json` 3 tầng qua `loadModeProfiles` (`src/cli/settings.ts:83`) — thêm khối `verify` cùng cơ chế.
- Graph node có `startedAt/finishedAt`, `workspace`, `workspaceMode` — đủ để tính sibling overlap.

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
      outsideScope: readonly string[]; ambiguousWith: readonly string[] }
  | { kind: "verify"; provenance: "observed"; source: "alp-verifier";
      commandId: string; exitCode: number; durationMs: number; tail: string }
  | { kind: "output"; provenance: "self-reported"; source: "agent-output"; digest: string }
  | { kind: "boundary"; provenance: "observed"; source: "runtime-event"; ref: ThreadExecutionBoundary };
```

### Quy tắc provenance (cứng, có test từng dòng)

| Nguồn | Điều kiện | Provenance |
|---|---|---|
| `git` | `ambiguousWith = []` **và** `policy.enforcement.writeIsolation === "enforced"` | `observed` |
| `git` | ngược lại | `derived` |
| `history-bridge` | completeness `complete` | `observed` |
| `history-bridge` | `partial` / `final-only` | `derived` |
| `history-bridge` | `unsupported` | item `unknown` |
| `agent-output` | luôn | `self-reported` |
| `alp-verifier`, `runtime-event` | luôn | `observed` |
| mọi nguồn | `policy.enforcement.measuredOn.runtimeVersion` ≠ version thật lúc launch (P5/P7) | hạ một bậc: `observed` → `derived` |

### Producer

1. **Git baseline** — `materialize()` của child `workspace-write`: `git rev-parse HEAD` + sha256(`git status --porcelain`) → `<execution>/context/baseline.json`. Không phải git repo ⇒ `baseline: null` ⇒ item `change` `unknown`. Sau settle: diff so với baseline ⇒ `paths`, `commit` (HEAD mới nếu đổi), `outsideScope` (path ∉ `writeScope`), `ambiguousWith` (sibling `workspace-write` cùng `workspace`, khoảng `[startedAt, finishedAt]` giao nhau, `writeScope` không rời nhau).
2. **Bridge cho child** — sau settle, `DelegationService` (wait/reconcile) gọi `bridge.collectDelta` trên child, ghi `<child>/context/history/` (cursor + entries), **không** vào Thread `messages/`. Items `tool-call`, `boundary`.
3. **`alp-verifier`** — `.alp/settings.json`:
   ```json
   { "verify": { "commands": [ { "id": "test", "run": "npm test", "timeoutMs": 600000, "cwd": "." } ] } }
   ```
   Chỉ tầng **project trở lên** (không user-global). Chạy sau settle, **ngoài** lease, trong workspace child, env tối thiểu (`PATH`, `HOME`), không shell login, timeout ⇒ `exitCode: -1`. `tail` ≤ 4 KB, redact.
4. **`state.json.output`** ⇒ item `output` với digest.

Toàn bộ chạy trong `collectEvidence(executionId)` — idempotent, ghi `<execution>/evidence.json` atomic; gọi lại chỉ bổ sung item còn thiếu.

### `requiredEvidence` + evaluator

```ts
// ChildRequest, DelegationRequestInput — vào fingerprint
readonly requiredEvidence?: readonly ("change" | `verify:${string}`)[];
// DelegationResult
readonly evidence: { digest: string; evaluation: "satisfied" | "unsatisfied" | "unknown";
                     missing: readonly string[] } | null;
```

Với mỗi mục: có item `observed | derived` khớp ⇒ đạt; item `unknown` ⇒ mục `unknown`; vắng ⇒ thiếu. Kết quả: mọi mục đạt ⇒ `satisfied`; có mục thiếu ⇒ `unsatisfied`; còn lại ⇒ `unknown`. `self-reported` **không** đạt mục nào. `verify:<id>` yêu cầu `exitCode === 0`.

CLI: `alp delegate --require-evidence change --require-evidence verify:test`; `alp delegation evidence <requestId>` (read-only, không cần binding) in đầy đủ.

## Việc phải làm

1. Test fail trước: bảng provenance từng dòng; overlap sibling (rời/giao, có/không scope); evaluator; git repo tạm với hai child song song ⇒ `ambiguousWith`; verify fail ⇒ `unsatisfied`; bridge `unsupported` ⇒ `unknown` không throw; không git ⇒ `unknown`; verify chỉ từ tầng project.
2. `src/execution/evidence.ts`: types, `collectEvidence`, `evaluateEvidence`, provenance table.
3. `src/execution/execution-service.ts`: `materialize` ghi baseline cho child `workspace-write`.
4. `src/delegation/delegation-service.ts`: sau settle gọi `collectEvidence`; `wait()` trả `evidence`; `DelegationResult`.
5. `src/execution/graph/execution-graph-service.ts`: `requiredEvidence` vào `ChildRequest` + fingerprint; node thêm `evidence: { digest, evaluation } | null` (additive).
6. `src/cli/settings.ts`: khối `verify` (`loadVerifyCommands`, tầng project+); `src/cli/commands/delegate.ts`: flags; `src/cli/commands/delegate.ts`: subcommand `evidence` cạnh `tree`.
7. `src/thread/history-bridge.ts`: không đổi contract; đảm bảo `HistoryExecutionSource` dựng được từ child (context dir của child).

## File đụng tới

| File | Hành động | Đổi gì |
|---|---|---|
| `src/execution/evidence.ts` | tạo | contract, collector, evaluator |
| `src/execution/execution-service.ts` | sửa | baseline |
| `src/delegation/delegation-service.ts`, `types.ts` | sửa | collect + result |
| `src/execution/graph/execution-graph-service.ts`, `types.ts` | sửa | `requiredEvidence`, node `evidence` |
| `src/cli/settings.ts`, `src/cli/commands/delegate.ts`, `src/cli/alp.ts` | sửa | verify, flags, lệnh |
| `test/execution/evidence.test.ts`, `test/delegation/evidence-collect.test.ts`, `test/e2e/evidence.test.ts` | tạo | |
| `test/e2e/harness.ts` | sửa | fake binary ghi file + transcript có tool call |
| `docs/delegation.md`, `docs/architecture.md` | sửa | evidence, `verify.commands` |

## Rủi ro

| Failure mode | Giảm thiểu |
|---|---|
| `verify.commands` chạy lệnh từ repo | Chỉ tầng project+, env tối thiểu, timeout, docs nói rõ — agent đã chạy lệnh trong repo đó |
| Verify chạy khi sibling khác còn ghi ⇒ kết quả nhiễu | Ghi `ambiguousWith` vào item `verify` luôn (cùng logic overlap); evaluator vẫn nhận nhưng `alp delegation evidence` in cảnh báo |
| Bridge child đọc transcript ngoài state dir | Guard hiện có của bridge (`realpath` trong state directory) giữ nguyên |
| `evidence.json` lớn vì tool-call nhiều | `tool-call` chỉ giữ `ThreadToolCallRef` (summary), payload thô nằm trong `context/history/` |
| Crash giữa `collectEvidence` | Atomic write; gọi lại idempotent; thiếu item = `unknown` |

## Tiêu chí hoàn thành

- `npx vitest run test/execution test/delegation test/e2e/evidence.test.ts` xanh.
- Delegation thật với `--require-evidence verify:test`: test fail ⇒ `unsatisfied`, pass ⇒ `satisfied`; `evidence.json` tồn tại cho mọi child settled.
- Thread `messages/` không đổi (assert trong E2E).
- `npm test` xanh.
