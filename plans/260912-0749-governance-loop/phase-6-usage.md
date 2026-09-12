# P6 — Usage telemetry + budget observe-only

<!-- Sửa: rà đối kháng lượt 2 (2026-09-12) — usage root cộng dồn trong ThreadExecutionRef, parser dùng pinnedVersion của bridge thay measuredOn -->

**Mục tiêu:** mỗi execution biết tốn bao nhiêu token / bao nhiêu tool call; child khai `budget` được đánh giá **sau** khi chạy; không hook mới, không chặn giữa chừng.
**Phụ thuộc:** P3 (bridge chạy cho child; evidence nhận item budget). Là phase cuối trước gate `orchestrator`.

---

## Bối cảnh

- Không có usage ở đâu trong `src/` (grep `usage` chỉ trúng text CLI).
- Child **không** chạy `-p`/stream-json (`src/runtime/adapter-files.ts:102` chỉ truyền task text). Root interactive cũng không. ⇒ transcript là đường duy nhất cho cả hai.
- `HistoryBridge` đã mở đúng transcript (`history-bridge.ts:86-118`, `realpath` trong state dir): Claude JSONL có `message.usage` trên assistant entry; Codex rollout có event `token_count`. Bridge đã có `pinnedVersion` + `completenessForVersion` (`codex-history-bridge.ts:3,52,75`) — parser usage nằm **trong** bridge và dùng đúng cơ chế đó; không dựng `measuredOn` riêng. **Việc đầu tiên của phase:** xác nhận hai định dạng trên version đã pin, ghi `research/transcript-usage.md`; version khác pin ⇒ completeness hạ như entries.
- Root: cursor bridge do `collectHistory` tiến, `run-main.ts` gọi hai lần (`:116` sau recover, `:217` sau settle) ⇒ usage root phải **cộng dồn** qua các lần gọi, không đọc lại từ đầu.
- Review V2 từng nói "root không đo được" — sai, đã sửa ở `plan.md` §Rà đối kháng #11.

## Thiết kế

### Contract

```ts
// src/execution/usage.ts
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
// ChildRequest, DelegationRequestInput — vào fingerprint
readonly budget?: { readonly tokens?: number; readonly toolCalls?: number };
// DelegationResult
readonly usage: ExecutionUsageV1 | null;
readonly budgetStatus: "within" | "exceeded" | "unknown";
```

- Bridge trả thêm `usageDelta` trong `HistoryDelta` (additive) — chỉ cho dòng mới sau cursor; Claude/Codex mỗi cái một parser; parse lỗi ⇒ `null`, không throw.
- **Child:** `collectEvidence` (P3) chạy bridge một lần sau settle ⇒ ghi `<execution>/usage.json` một lần. **Root:** `ThreadExecutionRef.history` thêm `usage: ExecutionUsageV1 | null` (additive), `collectHistory` cộng `usageDelta` vào đó dưới Thread lease cùng lúc commit cursor — cursor và tổng dồn đi cùng một commit, không lệch.
- Graph node `usage: { inputTokens, outputTokens, toolCalls } | null` (additive) để `alp delegation tree` tính tổng không mở file.
- `budgetStatus`: `exceeded` là **evidence** — thêm item `boundary` mở rộng `{ budget, usage, status }` vào `EvidenceItemV1` (P3 type mở rộng additive) để accept/reject thấy. `unknown` khi bất kỳ số cần so là `null`.
- Root: `settleRoot` ghi usage vào boundary (additive) — Thread thấy tổng theo E-n.

### Consumer

`alp delegation tree --json`: usage từng node + tổng theo cây (`null` lan lên = tổng `null` với `partial: true`). `alp thread show`: tổng theo execution. `wait()`: `budgetStatus`. `alp delegate --budget-tokens N --budget-tool-calls N`.

### Không làm

Hard budget (chặn call thứ N+1) — cần `PreToolUse` hook, Codex không có tương đương. ADR riêng (`plan.md` §Câu hỏi còn mở #1).

## Việc phải làm

0. **Đo**: lấy transcript thật hai runtime, ghi fixture (redact) vào `test/fixtures/transcripts/`.
1. Test fail trước: parser hai định dạng trên fixture; `null` khi format lạ; root: hai lần `collectHistory` ⇒ tổng = tổng hai delta, không đếm đôi; tổng theo cây với `null`; `budgetStatus` ba trạng thái; fingerprint đổi khi budget đổi; E2E fake binary ghi transcript có usage ⇒ tree tổng đúng; không hook mới trong settings.json phát ra.
2. `src/execution/usage.ts`: contract, `sumUsage`, `evaluateBudget`.
3. `src/thread/history-bridge.ts` + `src/runtime/{claude,codex}-history-bridge.ts`: `usageDelta` theo pinned version; `thread-service.ts collectHistory` cộng dồn vào `ref.history.usage`.
4. `src/delegation/delegation-service.ts`: ghi `usage.json`, trả result; `src/execution/graph/*`: `budget`, node `usage`.
5. `src/execution/evidence.ts`: item boundary mở rộng.
6. `src/thread/thread-service.ts`: `settleRoot` boundary usage.
7. CLI: flags `--budget-*`, tree/show in usage.

## File đụng tới

| File | Hành động | Đổi gì |
|---|---|---|
| `src/execution/usage.ts` | tạo | |
| `src/thread/history-bridge.ts`, `src/runtime/*-history-bridge.ts`, `src/thread/types.ts` | sửa | `usageDelta`, `ref.history.usage` |
| `src/delegation/*`, `src/execution/graph/*`, `src/execution/evidence.ts` | sửa | budget, node usage, evidence item |
| `src/thread/thread-service.ts`, `history-types.ts` | sửa | boundary usage |
| `src/cli/commands/delegate.ts`, tree/show | sửa | flags, in |
| `test/fixtures/transcripts/*`, `test/execution/usage.test.ts`, `test/thread/bridge-usage.test.ts`, `test/e2e/usage.test.ts` | tạo | |
| `docs/delegation.md`, vision §4.10 | sửa | "có, observe-only" |

## Rủi ro

| Failure mode | Giảm thiểu |
|---|---|
| Transcript format đổi theo version | `completenessForVersion` hiện có hạ completeness; `null` khi parse lỗi; `alp doctor` cảnh báo khi tỷ lệ `unknown` cao |
| Root crash giữa hai lần `collectHistory` | Tổng dồn commit cùng cursor dưới lease — hoặc cả hai tiến, hoặc không |
| Usage sai vì cache token đếm khác nhau giữa runtime | Bốn cột tách riêng, không cộng thành một số "tổng" trong contract; tree in từng cột |
| Ai đó coi `exceeded` là lỗi và chặn | Docblock + test: `exceeded` không đổi outcome của child |

## Tiêu chí hoàn thành

- `npx vitest run test/execution test/thread test/e2e/usage.test.ts` xanh.
- `alp delegation tree` in token/tool-call cho mọi node trên cả hai runtime thật; `--budget-tokens` ⇒ `exceeded` đúng.
- `grep -r PreToolUse src/` không có kết quả mới.
- `npm test` xanh. **Gate `orchestrator`** đánh dấu trong `plan.md` (cùng P5).
