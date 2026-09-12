# P1 — Approval hẹp (M3, prepare-time)

**Mục tiêu:** `PolicyDecision` có nhánh `require_approval`; chỉ **một** surface hỏi được (`alp` root TTY); mọi surface khác ⇒ `deny`. Hai rule cụ thể, không hơn.
**Phụ thuộc:** không. Độc lập với P2–P7.

---

## Bối cảnh

- `Authorization` (`src/policy/types.ts:22`) hiện là `{ allowed: true } | { allowed: false; code; reason }`. Không có nhánh hỏi.
- `ExecutionService.authorize()` phát vé `ExecutionAuthorization` (`src/execution/types.ts:198`); `materialize()` chỉ nhận vé. Approval phải xảy ra **trước** khi vé ra đời.
- Chỉ `runMainSession` đặt `interactive: true` (`claude-adapter.ts:190-196`); `alp delegate` luôn `false` và chạy dưới tool call của model — stdout về model, không có principal.
- Vision M3: `PolicyDecision` có `prompt`, `scope: once | execution | session`; background/specialist ⇒ deny.

## Thiết kế

### Contract

```ts
// src/policy/types.ts
export type ApprovalRuleId = "workspace-outside-grant-inside-project" | "mode-requires-approval";
export type PolicyDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly code: PolicyErrorCode; readonly reason: string }
  | { readonly kind: "require_approval"; readonly rule: ApprovalRuleId;
      readonly prompt: string; readonly scope: "once" | "execution" | "session" };

// src/execution/types.ts — ExecutionPolicy, vào policyHash
readonly approvals: readonly ApprovalRecordV1[];   // [] khi không có; key bắt buộc
export interface ApprovalRecordV1 {
  readonly version: 1;
  readonly rule: ApprovalRuleId;
  readonly scope: "once" | "execution" | "session";
  readonly decidedBy: "principal";
  readonly decidedAt: string;
}
```

`Authorization` giữ nguyên làm kết quả cuối. `PolicyDecision` là bước trung gian trong `ExecutionService.authorize()`:

```text
engine.decide(request) → allow                      → vé
                       → deny                       → Authorization{allowed:false}
                       → require_approval
                           surface.supportsApproval === false → allowed:false, code APPROVAL_UNAVAILABLE
                           surface hỏi → no                    → allowed:false, code APPROVAL_DENIED
                                      → yes                    → vé + ApprovalRecordV1 vào policy
```

### Surface

`ApprovalSurface { supportsApproval: boolean; ask(decision): Promise<boolean> }` — thuộc **surface**, không thuộc runtime adapter. `runMainSession` truyền surface TTY (stdin/stdout của `alp`); `alp delegate` truyền `NO_APPROVAL_SURFACE`. Không có surface = `deny`, không phải `allow`.

### Scope

- `once`: không lưu.
- `execution`: nhớ trong lần `authorize()` này.
- `session`: đời của **root execution** hiện tại — `<root execution>/context/approvals.json`, chỉ root đọc, `0600`. Không có khái niệm session nào khác.

### Rule ở phase này

1. `workspace-outside-grant-inside-project`: `--workspace` ngoài các root đã grant nhưng nằm **trong** project root hiện tại → hỏi thay vì `WORKSPACE_NOT_GRANTED`. Ngoài project root ⇒ vẫn `deny`.
2. `mode-requires-approval`: nấc có `requiresApproval: true` trong mode profile (mặc định built-in: `ultra`) → hỏi một lần/session.

**Không hỏi** cho tool grant, delegation target, memory — là identity, giữ `deny`.

## Việc phải làm

1. Test fail trước: engine trả `require_approval` đúng rule/đúng scope; `authorize()` với surface giả yes/no/absent; `policyHash` đổi khi `approvals` đổi; `approvals.json` chỉ root đọc; child chạm rule ⇒ `APPROVAL_UNAVAILABLE` không spawn.
2. `src/policy/types.ts`: `PolicyDecision`, `ApprovalRuleId`, hai code mới `APPROVAL_UNAVAILABLE | APPROVAL_DENIED`.
3. `src/policy/policy-engine.ts` + `workspace-policy.ts`: `decide()` bọc `authorize()` hiện có; hai rule.
4. `src/execution/types.ts`, `src/execution/execution-policy.ts`: `approvals` vào snapshot + hash; reader chấp nhận snapshot cũ thiếu key (test cutover).
5. `src/execution/execution-service.ts`: `authorize()` nhận `ApprovalSurface`.
6. `src/cli/commands/run-main.ts`: surface TTY; `src/cli/commands/delegate.ts`: `NO_APPROVAL_SURFACE`.
7. `src/agents/modes.ts` / `mode-settings.ts`: `requiresApproval?: boolean` trong profile.
8. `alp thread show`, `alp delegation tree`: in `approvals`.

## File đụng tới

| File | Hành động | Đổi gì |
|---|---|---|
| `src/policy/types.ts`, engine | sửa | `PolicyDecision`, hai rule, hai code |
| `src/execution/types.ts`, `execution-policy.ts`, `execution-service.ts` | sửa | `approvals`, `ApprovalSurface` |
| `src/cli/commands/run-main.ts`, `delegate.ts` | sửa | surface TTY / none |
| `src/agents/modes.ts`, `mode-settings.ts` | sửa | `requiresApproval` |
| `test/policy/approval.test.ts`, `test/execution/approval-surface.test.ts`, `test/e2e/approval.test.ts`, `test/cutover/policy-approvals.test.ts` | tạo | |
| `docs/alp-design-philosophy-and-vision.md` | sửa | M3 → "đã có, phạm vi hẹp"; chú thích approval theo cây là ADR |

## Rủi ro

| Failure mode | Giảm thiểu |
|---|---|
| Prompt TTY hiện giữa lúc runtime đã chiếm stdin | Hỏi **trước** spawn, trong `authorize()`; sau spawn không còn rule nào hỏi |
| `approvals.json` bị sửa tay để "đã duyệt" | Chỉ ảnh hưởng `session` scope của chính root đó; record vào policy của execution mới vẫn ghi `decidedAt` mới; không cấp quyền gì ngoài hai rule |
| Hai rule quá ít để đáng làm | Cố ý: phase này chốt *cơ chế* + surface; rule thêm là additive |

## Tiêu chí hoàn thành

- `npx vitest run test/policy test/execution test/e2e/approval.test.ts test/cutover` xanh.
- `alp --workspace <path-trong-project-ngoài-grant>` hỏi trên TTY; trả lời no ⇒ không có execution nào trên đĩa; yes ⇒ `policy.json.approvals[0].rule` đúng.
- `alp delegate` từ child chạm rule ⇒ `APPROVAL_UNAVAILABLE`, graph không có node mới.
- `npm test` xanh.
