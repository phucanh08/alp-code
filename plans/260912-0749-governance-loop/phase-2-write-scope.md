# P2 — `writeScope`

<!-- Implement 2026-09-12, xem "Đã làm khác plan" cuối file -->

<!-- Sửa: rà đối kháng lượt 2 (2026-09-12) — assert executions root không ghi được -->

**Mục tiêu:** child `workspace-write` khai được *tập đường dẫn* nó được ghi; ALP cưỡng chế ở mức runtime cho phép và **ghi rõ** mức đó.
**Phụ thuộc:** không (P1 độc lập). Việc đầu tiên: **đo** precedence `allowWrite`/`denyWrite` của Claude sandbox trước khi code.

---

## Bối cảnh

- `ChildRequest` (`src/execution/graph/execution-graph-service.ts:153`), `requestFingerprint` (`:223`) hash `parentExecutionId, agentId, task, workspace, workspaceMode, mode, background, interactive, timeoutMs`.
- `DelegationRequestInput` (`src/delegation/types.ts`); flags ở `src/cli/commands/delegate.ts`.
- Codex: `codexSandboxLines` (`permission-rules.ts`) phát `[sandbox_workspace_write] writable_roots = [policy.workspace, memory/private/<role>]`. Đã đo Codex cưỡng chế write (2026-09-10).
- Claude: `claude-adapter.ts:125-130` chỉ dùng `sandbox.filesystem.denyWrite: [activeWorkspace]` cho read-only; `sandboxAvailable()` false trên Windows.
- `PolicyEngine` đã kiểm child hẹp hơn cha cho depth/workspace — tái dùng cho scope.

## Thiết kế

### Contract

```ts
// ChildRequest, DelegationRequestInput
readonly writeScope?: readonly string[];        // relative to workspace; canonicalize; phải nằm trong workspace
// ExecutionPolicy — vào policyHash
readonly writeScope: readonly string[] | null;  // null = toàn workspace (hành vi cũ)
```

- Chỉ hợp lệ với `workspaceMode === "workspace-write"`; kèm `read-only` ⇒ `WRITE_SCOPE_ON_READ_ONLY` ở authorize.
- Canonicalize: resolve symlink, reject `..` ra ngoài, reject path ngoài workspace ⇒ `WRITE_SCOPE_OUTSIDE_WORKSPACE`.
- **Thêm** `writeScope` vào `requestFingerprint`.
- Child của child: `writeScope ⊆` của cha (null cha = toàn workspace) ⇒ kiểm trong `PolicyEngine`, code `WRITE_SCOPE_EXCEEDS_PARENT`.
- CLI: `alp delegate --write-scope <path>` lặp được.

### Enforcement

| Runtime | Cách | Mức |
|---|---|---|
| Codex | `writable_roots = [...writeScope.map(abs), memory/private/<role>]` thay `policy.workspace` | `enforced` (đã đo write isolation) |
| Claude darwin/linux, phương án (a) | `sandbox.filesystem.allowWrite: writeScope` + `denyWrite: [workspace]` | `enforced` nếu đo thấy allow thắng deny cho path con |
| Claude, phương án (b) | permission rules `deny: Write(<ws>/**), Edit(<ws>/**)` + `allow: Write(<scope>/**), Edit(<scope>/**)` | `declared-only` cho Bash ghi file |
| Claude win32 | (b) | `declared-only` |

Kết quả đo ghi vào bảng capability tối thiểu (`src/runtime/capabilities.ts` tạo ở đây dạng rút gọn; P5 hoàn thiện) và vào `enforcementNotes`.

### Consumer

P3 dùng `writeScope` để phân loại change `inScope | outsideScope` và tách diff giữa sibling. `alp delegation tree` in scope.

## Việc phải làm

0. **Đo** trên máy dev với `claude` thật: allowWrite/denyWrite precedence; ghi kết quả + version vào `research/claude-sandbox-precedence.md`.
1. Test fail trước: canonicalize (symlink ra ngoài, `..`, absolute ngoài ws); fingerprint đổi khi scope đổi; `policyHash` đổi; child vượt cha ⇒ lỗi; config Codex/Claude sinh đúng; executions root không bao giờ nằm trong `writable_roots`/`allowWrite`.
2. `src/execution/graph/execution-graph-service.ts`: `ChildRequest.writeScope`, fingerprint.
3. `src/delegation/types.ts`, `delegation-service.ts`: truyền qua; `src/cli/commands/delegate.ts`: `--write-scope`.
4. `src/policy/*`: ba code mới + kiểm ⊆ cha.
5. `src/execution/types.ts`, `execution-policy.ts`: `writeScope` snapshot; cutover reader.
6. `src/runtime/permission-rules.ts`: `codexSandboxLines` dùng scope; Claude rules theo phương án đã đo. `src/runtime/claude-adapter.ts`: sandbox config.
7. `src/runtime/capabilities.ts`: bảng tối thiểu `{ runtime, platform, writeScope: EnforcementLevel }`.

## File đụng tới

| File | Hành động | Đổi gì |
|---|---|---|
| `src/execution/graph/execution-graph-service.ts` | sửa | `writeScope`, fingerprint |
| `src/delegation/types.ts`, `delegation-service.ts`, `src/cli/commands/delegate.ts` | sửa | truyền + flag |
| `src/policy/types.ts`, engine | sửa | 3 code, kiểm ⊆ |
| `src/execution/types.ts`, `execution-policy.ts` | sửa | snapshot |
| `src/runtime/permission-rules.ts`, `claude-adapter.ts`, `codex-adapter.ts` | sửa | enforcement |
| `src/runtime/capabilities.ts` | tạo | bảng tối thiểu |
| `test/execution/graph/write-scope.test.ts`, `test/runtime/write-scope-rules.test.ts`, `test/e2e/write-scope.test.ts` | tạo | |
| `docs/delegation.md` | sửa | flag + bảng enforcement |

## Rủi ro

| Failure mode | Giảm thiểu |
|---|---|
| Claude allow không thắng deny ⇒ scope không cưỡng chế được bằng sandbox | Phương án (b), bảng ghi `declared-only`; evidence P3 hạ `derived` |
| Scope chứa symlink trỏ ra ngoài sau khi launch | Canonicalize lúc authorize; P3 ghi `outsideScope` nếu diff thấy path ngoài |
| Memory private root bị mất khỏi `writable_roots` khi thay list | Test assert luôn có `memory/private/<role>` |
| Scope hoặc workspace trùm lên executions root ⇒ child sửa được `policy.json`/`approvals.json`/`evidence.json` | Authorize từ chối scope/workspace chứa executions root (`WRITE_SCOPE_OUTSIDE_WORKSPACE` hoặc mã hiện có cho workspace); test assert executions root ∉ mọi `writable_roots`/`allowWrite` phát ra |

## Tiêu chí hoàn thành

- `npx vitest run test/execution test/runtime test/policy test/e2e/write-scope.test.ts` xanh.
- Đo thật một lần: `alp delegate worker --write-scope src/foo` ⇒ Codex ghi ngoài `src/foo` bị chặn; Claude theo phương án đã chọn; kết quả + version ghi `research/`.
- `policy.json` có `writeScope`; `alp delegation tree --json` in scope.
- `npm test` xanh.

## Đã làm khác plan (implement 2026-09-12)

| Plan nói | Làm thật | Vì sao |
|---|---|---|
| Claude phương án (a) `allowWrite: scope` + `denyWrite: [workspace]` ⇒ `enforced` | Đo trên 2.1.269 (`research/claude-sandbox-precedence.md`): `denyWrite` **thắng** `allowWrite`, `Write(path)` rule bị bỏ qua, `Edit(path)` áp cho Write/NotebookEdit/MultiEdit. Làm phương án **liệt kê anh em**: `writeScopeDenyPaths()` đi từ workspace xuống tới từng scope, deny mọi entry không nằm trên đường — vào cả `permissions.deny Edit(//…/**)` lẫn `sandbox.filesystem.denyWrite`. Không bao giờ phát `allowWrite` | (a) không dùng được; (b) thuần rule thì shell ghi được ngoài scope. Liệt kê cho sandbox chặn cả shell, nhưng chỉ chặn thứ tồn tại lúc phóng |
| Ba mức `enforced / declared-only / none` | Thêm mức **`partial`** (`ENFORCEMENT_LEVELS`, `LEVEL_PHRASES`, `readEnforcement`); Claude darwin/linux `writeScope: partial`. `test/runtime/capabilities.test.ts` đổi kỳ vọng `none` → `partial` — thay đổi oracle theo phép đo, không theo code | "Chặn những gì liệt kê được lúc phóng, không hơn" không phải `enforced` (luật) và không phải `declared-only` (không ai chặn). Nói đúng mức thì evidence P3 mới đọc đúng |
| Ba code mới | Năm: thêm `WRITE_SCOPE_NOT_FOUND` (entry không tồn tại — không tạo hộ, không scope tới rỗng) và `WRITE_SCOPE_PROTECTED_ROOT` (entry hoặc workspace ghi không scope trùm `~/.alp/executions/`, qua `PolicyEngineOptions.protectedRoots`; `alp.ts` và `delegate.ts` truyền `executionsDirectory()`) | Rủi ro cuối bảng: dùng `WRITE_SCOPE_OUTSIDE_WORKSPACE` cho executions root là nói sai lý do — nó *nằm trong* workspace, chỉ là không được ghi. Mã riêng thì `alp delegate` nói đúng chuyện cho principal |
| `alp delegation tree --json` in scope | `alp delegation status` (`DelegationResult.writeScope`, đọc từ `policy.json` đã ký); `DelegationExecutionRecord.writeScope` | Cây giữ quan hệ, không giữ bản sao thứ hai của quyền (nguyên tắc `graphRecord`): scope đọc từ snapshot đã băm, như `workspace` và `runtime` |
| Kiểm ⊆ cha bằng `writeScope` của cha "từ request" | `launch.writeScope` đọc từ `policy.json` **của cha** (`readWriteScope(parentSnapshot)`), `null` tường minh khi cha không scope; con không scope dưới cha có scope ⇒ workspace con phải nằm trong scope cha | Cùng lý do grant đọc từ snapshot cha chứ không từ request: field người gọi tự điền không phải nguồn quyền |
| Bảng capability "tối thiểu" tạo ở P2 | Bảng đã có từ P5 (làm trước); P2 chỉ đổi một ô và thêm mức | Thứ tự thực thi 1 → 5 → 2 |
| "Đo thật một lần `alp delegate worker --write-scope`" | Đo precedence sandbox Claude thật (bước 0); e2e `test/e2e/write-scope.test.ts` kiểm config sinh ra cho Codex (`writable_roots`) và Claude (`denyWrite` + `Edit` deny) qua harness với runtime giả | Phép đo thật đã trả lời câu hỏi quyết định thiết kế; chạy end-to-end với CLI thật là việc của `alp agent test` tầng 2 |
