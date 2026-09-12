# P2 — `writeScope`

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
1. Test fail trước: canonicalize (symlink ra ngoài, `..`, absolute ngoài ws); fingerprint đổi khi scope đổi; `policyHash` đổi; child vượt cha ⇒ lỗi; config Codex/Claude sinh đúng.
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

## Tiêu chí hoàn thành

- `npx vitest run test/execution test/runtime test/policy test/e2e/write-scope.test.ts` xanh.
- Đo thật một lần: `alp delegate worker --write-scope src/foo` ⇒ Codex ghi ngoài `src/foo` bị chặn; Claude theo phương án đã chọn; kết quả + version ghi `research/`.
- `policy.json` có `writeScope`; `alp delegation tree --json` in scope.
- `npm test` xanh.
