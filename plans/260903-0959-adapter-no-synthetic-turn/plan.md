---
status: in-progress
created: 2026-09-03
slug: adapter-no-synthetic-turn
source:
  - ALPADAPTERMASTERPLAN.md (bản Proposed 2026-09-03, đã đối chiếu source và cắt bỏ phần không áp dụng)
blockedBy: []
blocks: []
---

# Adapter: bỏ turn giả ở phiên interactive

## Tổng quan

Gõ `alp` để mở phiên interactive, nhưng agent trả lời trước khi principal kịp gõ gì. Nguyên nhân
không phải prompt viết sai — là **adapter đang vận chuyển session context bằng kênh của task**.

Bản master plan gốc chẩn đoán đúng chỗ này, nhưng phần lớn thiết kế đề xuất được viết mà không đọc
repo: nó dựng lại `PolicyIR` đã có tên `ExecutionPolicy`, đưa identity về file Markdown mà repo đã
cutover khỏi, và dùng `CLAUDE.md`/`AGENTS.md` mà một test đang cấm. Bản này giữ phần đúng, bỏ phần
còn lại, và ghi rõ lý do ở §9.

Phạm vi thật: **~1 ngày, 1 PR chính**, chạm 3 file source và 2 assertion test.

## 1. Vấn đề — đã đối chiếu source

| # | Sự kiện | Bằng chứng |
|---|---|---|
| 1 | Cả hai adapter append positional prompt vô điều kiện, kể cả interactive | `claude-adapter.ts:111` · `codex-adapter.ts:105` |
| 2 | CLI coi positional argument là user turn ⇒ model bị gọi trước khi principal gõ | `codex --help`: `codex [OPTIONS] [PROMPT]` — "Optional user prompt to start the session" |
| 3 | Phiên `alp` gửi task placeholder vô nghĩa vào turn đó | `run-main.ts:43` → `task: "Principal-facing main session"` |
| 4 | Shared renderer biết chi tiết từng harness | `adapter-files.ts:50-61` — doc-comment của `identityFromHook` nói thẳng "Claude applies `additionalContext`… Codex reports `SessionStart Failed`" |
| 5 | Một blob trộn identity + invariant + policy + memory + task | `adapter-files.ts:69-84` |
| 6 | Test đang khoá đúng behavior sai này | `test/runtime/runtime-adapters.test.ts:95` và `:240` |

Điểm 3 là chỗ đau nhất và ít ai để ý: turn giả đó không chỉ thừa, nó còn chứa **một task bịa ra**.

### 1.1. Bằng chứng đã đo — P0, 2026-09-03, `codex-cli 0.149.0`

`codex debug prompt-input` render đúng danh sách message model nhìn thấy, không tốn model call.

| # | Câu hỏi | Kết quả | Cách đo |
|---|---|---|---|
| 1 | Positional prompt có đúng là turn giả không? | **Có.** Không truyền PROMPT: 4 message, message cuối là `user` chỉ chứa `<environment_context>`. Truyền PROMPT: thêm message thứ 5 `role: user` = nội dung prompt | `codex debug prompt-input` có/không có PROMPT |
| 2 | `developer_instructions` nằm ở đâu? | Message `role: developer` **đầu tiên**, content block **đầu tiên**, trước cả `<skills_instructions>` của Codex. **Bổ sung, không thay thế** base instructions | `-c 'developer_instructions="SENTINEL"'` |
| 3 | Hook `SessionStart` của Codex 0.149 có chạy không? | **Có.** `hook: SessionStart Completed`, fire đúng 1 lần, payload đầy đủ (`session_id`, `cwd`, `hook_event_name`, `model`) | `codex exec` + `--dangerously-bypass-hook-trust --enable hooks` |
| 4 | `additionalContext` của hook có tới model không, và đúng thứ tự? | **Có.** Vào transcript thành message `role: developer` ở ordinal 8 — **trước** user turn ở ordinal 9 | đọc rollout `.jsonl` |

**Hệ quả — comment ở `adapter-files.ts:55-57` đã lỗi thời.** "Codex reports `SessionStart Failed`" không còn đúng với 0.149. Hook chạy, và `additionalContext` đáp xuống **cùng một shape** (`role: developer`) với `developer_instructions`.

Vì vậy §4.5 chốt **đường A**: một cơ chế duy nhất — SessionStart hook — cho cả hai runtime. Không
dùng `developer_instructions`. Điều này xoá luôn cả nhóm rủi ro escaping/command-length mà bản gốc
dành hẳn một milestone để xử lý: session context đi qua file, không qua argv.

Phân biệt trung tâm:

```text
SessionContext   ổn định theo phiên · không bao giờ tạo turn · authority = ALP
TaskInput        theo từng execution · tạo đúng một turn · authority = principal hoặc parent agent
```

Hôm nay hai thứ này đi chung một kênh. Đó là toàn bộ lỗi.

## 2. Phạm vi

| Trong phạm vi | Ngoài phạm vi |
|---|---|
| Tách `renderSessionContext()` / `renderTaskInput()` | Đổi tên `IdentityCapsule` → `ExecutionCapsule` |
| Bỏ positional prompt khi `interactive: true` | Mô hình identity mới (`SOUL.md`, `PRINCIPLES.md`, `AgentDefinition.identity`) |
| Vận chuyển session context qua primitive native của từng runtime | `PolicyIR` — đã tồn tại dưới tên `ExecutionPolicy` |
| Một serializer TOML duy nhất, có test | `CLAUDE.md` / `AGENTS.md` — bị `test/cutover` cấm |
| Adapter conformance suite dùng chung | Native bridge (`alp bridge install`) |
| Cập nhật `docs/architecture.md` §4.6, §4.8, §6 | Migration/deprecation program cho package `private: true` |

## 3. Nguyên tắc

Bốn nguyên tắc dưới đây là ràng buộc, không phải khẩu hiệu — mỗi cái có một test tương ứng ở §6.

1. **Zero synthetic turn.** `launch(interactive) ⇒ số turn trước input của principal = 0`.
2. **Session context ≠ task input.** Khác lifecycle, khác authority, khác kênh vận chuyển.
3. **Một kênh identity duy nhất mỗi runtime.** Nếu Codex nhận identity qua `developer_instructions`
   thì hook `SessionStart` không được emit identity nữa, và ngược lại. Hôm nay `codex-adapter.ts:96`
   đã wire hook *và* prompt mang `## Identity` — nếu hook bắt đầu chạy được, identity vào hai lần.
4. **Adapter chỉ dịch.** Đã là §4.11 của `docs/alp-design-philosophy-and-vision.md`. Shared renderer
   không được nhắc tên `claude`, `codex` hay `hook`.

Nguyên tắc "policy không nằm trong prompt" của bản gốc **không cần thêm** — `src/runtime/permission-rules.ts`
đã làm đúng như vậy từ v0.2.0, và `PolicyEngine` chạy trước mọi runtime probe.

## 4. Thiết kế

### 4.1. Hai renderer thay một

```ts
// src/runtime/render-session-context.ts
export function renderSessionContext(capsule: IdentityCapsule): string;
// IDENTITY · INVARIANTS · POLICY · REPORTING CONTRACT

// src/runtime/render-task-input.ts
export function renderTaskInput(capsule: IdentityCapsule): string;
// RELEVANT MEMORY · CURRENT TASK · EXPECTED OUTPUT
```

`CapsulePromptOptions` và `identityFromHook` bị xoá. Việc "identity đã tới bằng đường khác chưa" là
quyết định của từng adapter, không phải tham số của renderer.

Không giữ wrapper `renderCapsulePrompt()` deprecated: chỉ có 2 call site (`claude-adapter.ts:55`,
`codex-adapter.ts:47`), package là `private: true` ở v0.2.0, không consumer ngoài. Một commit xoá hết.

### 4.2. `interactive` giữ nguyên là boolean

Bản gốc đề xuất `ExecutionMode = "interactive" | "headless"`. `PrepareRuntimeInput.interactive: boolean`
đã tồn tại ở `runtime-adapter.ts:23` và mọi call site đã truyền đúng. Đổi sang union type là đổi tên
thuần tuý — bỏ.

### 4.3. `task` vẫn required trong capsule

Bản gốc đề xuất `task: ResolvedTask | null`. Làm vậy phải sửa `createIdentityCapsule`, `IdentityCapsule`,
`PrepareExecutionInput`, `ExecutionService` và output contract của workflow — nhiều rủi ro cho một PR
mà giá trị bằng không.

Cách rẻ hơn cho cùng kết quả: **giữ `task` required, nhưng interactive không vận chuyển nó**. `capsule.task`
tiếp tục sống trong `identity-capsule.json` như metadata audit ("execution này mở ra để làm gì"), và
không bao giờ trở thành turn. Việc dọn placeholder ở `run-main.ts:43` thành một chuỗi trung thực hơn
(`"Interactive principal session; task arrives from the principal"`) là 1 dòng.

Nếu về sau có nhu cầu thật cho `task: null`, mở plan riêng.

### 4.4. Claude — `ALP_SESSION_CONTEXT`

```text
Claude native system prompt
        ↓
SessionStart hook → additionalContext   ← ALP identity + invariants + policy + reporting
        ↓
turn 1 = câu thật của principal
```

Adapter ghi `session-context.md` vào runtime directory (đã có `atomicRuntimeFile`), truyền
`ALP_SESSION_CONTEXT=<absolute path>` cho child process. `hooks/session-boot.cjs` đọc biến này trước,
fallback về `.alp/agents/<role>.md` như hiện tại.

**Fail-closed đặt ở adapter, không ở hook.** Bản gốc đòi hook fail-closed, va vào một quyết định có
chủ đích: `session-boot.cjs:12-13` fail-open "unlike the policy hooks". Không cần đổi — `atomicRuntimeFile`
chạy *trước* khi spawn, nên ghi file hỏng thì `prepare()` throw và không tiến trình nào khởi động.
Đó mới đúng là fail-closed, và không tốn dòng code nào.

Hook giữ nguyên fail-open + `systemMessage` cảnh báo, cho đường native (`claude` gõ trực tiếp) — nơi
`ALP_SESSION_CONTEXT` không tồn tại và `.alp/agents/<role>.md` là thứ duy nhất có.

### 4.5. Codex — cùng cơ chế với Claude

Chốt theo P0 (§1.1): **SessionStart hook**, giống hệt Claude. Hook đọc `ALP_SESSION_CONTEXT` và
emit `additionalContext`; Codex biến nó thành message `role: developer` đứng trước user turn.

`codex-adapter.ts:96` đã wire sẵn hook. Việc còn lại chỉ là:

- ghi `session-context.md` + truyền env `ALP_SESSION_CONTEXT` (dùng chung code với Claude);
- bỏ `## Identity` khỏi prompt Codex (`identityFromHook: false` biến mất cùng renderer cũ) — nếu
  giữ, identity vào hai lần, vi phạm nguyên tắc 3;
- bỏ positional prompt khi interactive.

Không dùng `developer_instructions` dù nó hoạt động: hook cho cùng kết quả, dùng chung một đường
code với Claude, và không đẩy context vào argv. Không dùng `model_instructions_file` — nó thay base
instructions, vi phạm augment-không-replace.

### 4.6. Một serializer TOML

Hôm nay có hai bản `JSON.stringify` rời nhau: `codex-adapter.ts:13` và `permission-rules.ts:102`.
Gom về một chỗ và test — thuần DRY.

Ma trận escaping lớn của bản gốc (§10.4) **không còn cần**: sau §4.5 không có nội dung tự do nào đi
qua `-c` nữa. Giá trị cần escape chỉ còn là path và enum do chính ALP sinh. Test giữ lại phần thật
sự chạm tới: path Windows có backslash và space, Unicode/tiếng Việt, nháy kép.

## 5. Các phase

| Phase | Nội dung | Ước lượng | Phụ thuộc | Trạng thái |
|---|---|---|---|---|
| **P0** | Đo hai câu hỏi Codex ở §4.5 | ~1h | — | **xong 2026-09-03** — §1.1 |
| **P1** | Tách renderer · bỏ positional prompt interactive · `ALP_SESSION_CONTEXT` cho cả hai runtime · conformance suite | ~1 ngày | P0 | **xong 2026-09-03** |
| **P2** | Gom `tomlString` | ~1h | P1 | **xong 2026-09-03** — gộp vào P1 |
| **P3** | Tầm nhìn, **chưa mở khoá** — xem §8 | — | — | |

P0 làm P2 co lại từ ~0.5 ngày xuống ~1h: vì cả hai runtime dùng chung hook, phần Codex gộp luôn vào
P1 và `tomlString` chỉ còn là dọn DRY.

**P1 và P3 của bản gốc phải gộp.** Bản gốc xếp "bỏ positional prompt" (P0) trước "Claude session-native
injection" (P1). Làm theo thứ tự đó tạo cửa sổ regression: hôm nay Claude nhận identity tĩnh từ hook,
còn **invariants + policy + reporting contract chỉ đến từ positional prompt** (`adapter-files.ts:74-83`,
nội dung thật ở `run-main.ts:48-49`). Bỏ prompt mà chưa có `ALP_SESSION_CONTEXT` là phiên interactive
mất ba mục đó. Hai việc này là một PR, không phải hai milestone.

### P0 — hai phép đo (xong)

```bash
# 1+2. Danh sách message model nhìn thấy — không tốn model call.
codex debug prompt-input -c 'developer_instructions="SENTINEL"'            # không có turn user
codex debug prompt-input -c 'developer_instructions="SENTINEL"' "task"     # thêm turn user

# 3+4. Hook có chạy và context có tới đúng thứ tự không — cần session thật.
codex exec --skip-git-repo-check --dangerously-bypass-hook-trust --enable hooks \
  -c "hooks.SessionStart=$HOOK" -s read-only "Reply with exactly: PROBE-DONE" < /dev/null
# rồi đọc ~/.codex/sessions/**/rollout-*.jsonl
```

`codex debug prompt-input` là công cụ đúng cho loại đo này và không tốn model call — ghi lại để lần
sau không ai phải mò. Kết quả ở §1.1.

### P1 — checklist

- [x] `src/runtime/render-session-context.ts` + `render-task-input.ts`
- [x] Xoá `renderCapsulePrompt`, `CapsulePromptOptions`, `identityFromHook` khỏi `adapter-files.ts`
- [x] `session-context.md` + env `ALP_SESSION_CONTEXT` — dùng chung qua `writeRuntimeContextFiles()`
      và `baseRuntimeEnvironment()`, nên không adapter nào quên được
- [x] `task.md` chỉ sinh khi headless; positional prompt qua `taskArguments()`, rỗng khi interactive
- [x] `hooks/session-boot.cjs`: đọc `ALP_SESSION_CONTEXT` trước, fallback `.alp/agents/<role>.md`
- [x] Cập nhật comment lỗi thời về `SessionStart Failed` của Codex
- [x] `run-main.ts`: task placeholder thành chuỗi trung thực
- [x] Conformance suite ở §6 · `test/hooks/session-boot.test.ts` (hook chưa từng có test)
- [x] `docs/architecture.md` §4.6, §4.8, §6

### Kết quả — smoke trên CLI thật (`scripts/alp.cjs`, fake `claude` trên PATH)

| Lệnh | argv cuối | `ALP_SESSION_CONTEXT` |
|---|---|---|
| `alp --runtime claude` | `--dangerously-skip-permissions` — **không có positional prompt** | có, file đủ identity + authority + invariants + policy + reporting |
| `alp delegate search "…" --runtime claude --backend local` | `ALP task is in …/task.md; execute it.` | có |

`npm run typecheck` · `npm test` (205 pass, 25 file) · `npm run build` đều xanh.

Một điều phát hiện khi sửa test e2e, đáng ghi lại: `run-main.ts` hardcode `interactive: true` khi
gọi `adapter.prepare()` — `dependencies.interactive` chỉ điều khiển việc có hỏi chọn runtime hay
không. Nghĩa là **mọi** phiên `alp` đều interactive, nên không phiên nào submit task. Đúng ý muốn,
nhưng hai chữ `interactive` mang hai nghĩa khác nhau trong cùng một hàm — xem §10.

## 6. Conformance suite

Mọi adapter — kể cả runtime thêm sau — chạy chung bộ này:

| Trường hợp | interactive | headless |
|---|---:|---:|
| Session context được inject | Có | Có |
| Có positional prompt trong `args` | **Không** | Có |
| Task được submit tự động | Không | Có, đúng một lần |
| Identity đi qua đúng một kênh | Có | Có |
| Policy được map ra config native | Có | Có |
| Base instructions của harness bị replace | Không | Không |

```ts
expect(interactiveSpec.args).not.toContain(expect.stringContaining("prompt.md"));
expect(headlessSpec.args.at(-1)).toMatch(/task/);
```

Bộ này thay hai assertion đang khoá behavior sai ở `runtime-adapters.test.ts:95,240`.

## 7. Rủi ro

| Rủi ro | Tác động | Xử lý |
|---|---|---|
| Bỏ positional prompt trước khi có session context transport | Phiên interactive mất invariants/policy/reporting | Gộp thành một PR — §5 |
| Identity vào hai lần trên Codex (hook + developer_instructions) | Tốn token, mâu thuẫn nội dung | Nguyên tắc 3 ở §3, có conformance test |
| `developer_instructions` đổi ngữ nghĩa giữa các bản Codex | Adapter hỏng sau `codex update` | Đo ở P0 · pin supported range · smoke test theo release candidate |
| Hook Codex vẫn hỏng nhưng lỗi im lặng | Phiên chạy không có identity, không ai biết | P0 phải phân biệt được "chạy" với "im lặng không chạy" |
| `.alp/agents/<role>.md` chưa sync ở đường native | Session thiếu identity | Giữ `systemMessage` cảnh báo hiện có |

## 8. P3 — tầm nhìn, chưa mở khoá

Codex app-server tách đúng thứ plan này đang phải mô phỏng bằng CLI args:

```text
thread/start  → tạo session + developer instructions   (không tạo turn)
turn/start    → gửi user task                          (tạo turn)
```

Đó là biểu diễn trực tiếp của nguyên tắc 1. Nhưng nó chỉ đáng làm khi ALP thực sự sở hữu vòng lặp
tương tác — tức là sau khi có TUI riêng, và sau `§4.10` (observability/budget/cancellation) của
vision doc. Điều kiện mở khoá và ràng buộc ở [`docs/orchestrator-vision.md`](../../docs/orchestrator-vision.md).

Không viết code cho P3 trong plan này.

## 9. Đã bỏ khỏi bản gốc — và vì sao

Ghi lại để lần sau không ai đề xuất lại.

| Bản gốc | Lý do bỏ |
|---|---|
| §1, §11, M7 — `CLAUDE.md`/`AGENTS.md` làm project instruction surface | `test/cutover/no-legacy-identity.test.ts:29,61-63` fail nếu hai file đó tồn tại hoặc bị nhắc tên trong code. Vision doc §11 quyết định #1 đã chọn `agent.yaml` thay `AGENT.md`, có lý do ghi rõ |
| §6.1, §12 — `.alp/identity/{IDENTITY,SOUL,PRINCIPLES}.md` làm canonical store | Đảo ngược invariant #1 "Identity là code, không phải Markdown" (`docs/architecture.md:19`). `.alp/agents/<role>.md` là **cache dẫn xuất** sinh từ registry (`identity-sync.ts:21-27`), không phải nguồn |
| §6.2, M5 — một agent `alp` + role thay được (coder/reviewer/planner) | Repo có 8 agent, mỗi cái có `capabilities.memory` grants riêng, `delegatesTo`, `reportsTo`, workflow state machine, output contract. "Role" của bản gốc = "agent" ở đây. Gộp về một stable identity làm mất memory scope theo agent và delegation graph — hai thứ policy đang cưỡng chế. Việc chống trùng lặp instructions đã do `shared/house-rules.ts` + `shared/voice.ts` giải |
| §8, §10.5, M6 — `PolicyIR` + `ClaudePolicyAdapter`/`CodexPolicyAdapter` | Đã có: `ExecutionPolicy` (`execution/types.ts:16`) là IR; `claudePermissions()`/`codexSandboxLines()` (`permission-rules.ts`) là hai policy adapter. Shape `{filesystem, shell, network, tools, approvals}` của bản gốc **mất** `memory` grants và `delegatesTo`. `require_approval` đã được chốt là quyết định của core ở vision §4.7/§6 |
| §6.3, M6 — đổi tên `IdentityCapsule` → `ExecutionCapsule` | Churn thuần. Tên hơi sai, nhưng nếu đổi thì một commit, không phải migration 4 giai đoạn |
| §12 — cấu trúc source đề xuất | Thiếu hẳn `delegation/`, `backend/`, `workflow/`, `memory/`. Áp dụng nguyên văn là đổi tên thư mục lấy con số không |
| §18 — dual renderer, deprecated alias, `adapterVersion = 2`, "ít nhất một release phát warning" | `package.json` là `private: true`, v0.2.0, không consumer ngoài. 2 call site. Nghi lễ của thư viện public áp lên repo một-PR-sửa-hết |
| §8.2, M7 — native bridge `alp bridge install\|refresh\|status\|remove` | Đường native đã có sẵn qua `.alp/agents/<role>.md` + fallback trong hook. Thêm 4 subcommand, drift detection và managed-block marker cho một nhu cầu chưa ai nêu |
| §9.3 — hook fail-closed | `session-boot.cjs:12-13` fail-open có chủ đích. Fail-closed đặt đúng chỗ là ở adapter — §4.4 |
| §17 — phần lớn security requirements | Đã có: `atomicRuntimeFile` ghi atomic mode 0600 (`adapter-files.ts:38-48`), `resolveWorkspace` canonicalize qua `realpath` (`execution-service.ts:61,89`), cleanup giới hạn trong `temporaryFiles` |
| §16 — audit metadata mới | Đã có `definitionHash` + `policyHash` trong capsule và execution state |

## 10. Câu hỏi còn mở

1. **Phiên interactive có nên tạo execution record + state file không?** `run-main.ts:63-78` đọc
   `stateFile` để lấy `output`. Khi không có task và không có output contract theo nghĩa thường,
   contract đó nghĩa là gì? Chưa cần trả lời để làm P1, nhưng sẽ chặn P3.
2. **Session context nên chứa selected memory không?** Hiện `run-main.ts:46-47` truyền
   `memoryQueries: []`, `characterBudget: 0` — nên câu hỏi chưa phát sinh. Khi phiên interactive bắt
   đầu cần memory, memory thuộc task-time retrieval (đúng như bản gốc §4.6 nói), không thuộc session context.
3. **Codex có `AgentRoleToml` native** (`agent_role`, `nickname_candidates`, và ràng buộc "must define
   `developer_instructions`"). Chưa rõ nó có phải chỗ đúng để map `AgentDefinition` vào không, hay chỉ
   là trùng tên. Không chặn gì hiện tại vì §4.5 đã chọn hook.
4. **`interactive` mang hai nghĩa trong `run-main.ts`**: `dependencies.interactive` = "có TTY để hỏi
   chọn runtime không", còn `adapter.prepare({ interactive: true })` = "phiên này không submit task".
   Hai khái niệm khác nhau, cùng một tên, trong cùng một hàm. Chưa gây bug — `alp` luôn đúng cả hai
   nghĩa — nhưng là bẫy cho người sửa sau. Đổi tên là việc riêng, không gộp vào PR này.
