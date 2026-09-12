---
status: draft
created: 2026-09-12
slug: governance-loop
source: plans/260912-0749-governance-loop/research/roadmap-v3.md
blockedBy: []
blocks: []
---

# P2 — Governance loop cho delegation

## Tổng quan

Đóng vòng *giao việc có phạm vi → chạy dưới enforcement đo được → bằng chứng có nguồn gốc → chấp nhận có thẩm quyền* trên kernel hiện có. Sau plan này: `alp delegate --write-scope src/foo --require-evidence verify:test` sinh child chỉ ghi được trong `src/foo`; sau settle ALP có `evidence.json` với từng item ghi `observed | derived | self-reported | unknown`; cha gọi `alp delegation accept|reject <requestId>` được xác thực qua graph binding; quyết định đó vào Thread handoff như nguồn do ALP sinh, tách khỏi pins; principal được hỏi ở hai quyết định policy hẹp; mọi execution có usage post-hoc và launch receipt.

`Thread T ── E-1 (root) ── G-1 ── child C-1 [writeScope, requiredEvidence] ── evidence.json ── accept/reject ── projectContext(E-1) ─▶ E-2 thấy "Delegations of E-1"`

Nguồn sự thật: [roadmap V3](./research/roadmap-v3.md) — đã qua hai lượt review V1/V2, §12 ghi từng thay đổi và vì sao.

**Ngoài phạm vi:** Supervisor / policy pack / workspace governance; M1 (surface/UI), M4; resume runtime session; `AssignmentContract`/`LaunchContract`/`assignmentId`/lease riêng; budget "hard" chặn tool call giữa chừng (ADR riêng); approval đi lên theo cây cho child (ADR riêng); ExecutionGraph thành DAG; >1 active root/Thread; steer message vào process; markdown làm nguồn config; role `orchestrator` (là gate mở *sau* plan này, không nằm trong).

## Nguyên tắc bất biến

1. **Identity là code.** Thêm field vào `ExecutionPolicy` = field đó vào `policyHash`. Key bắt buộc, `null` khi vắng (`canonicalize()` bỏ `undefined`).
2. **ALP quyết ai giao cho ai.** `src/policy/**` không import `evidence | acceptance | usage | thread` — bảo vệ bằng test import-graph, không bằng review.
3. **Fail-closed.** Không đo được ⇒ `unknown`; không có surface để hỏi ⇒ `deny`; `self-reported` không thoả mãn `requiredEvidence` nào.
4. **Thread ≠ Execution ≠ Graph ≠ Process.** Thread vẫn root-only; evidence/acceptance của child nằm dưới thư mục execution và graph node, tới Thread chỉ qua `projectContext`.
5. **Không hai nguồn truth cho một lifecycle.** Acceptance là record thêm vào node đã settled, không phải trạng thái mới; `undecided` derive từ vắng record.
6. **Không nest lease.** Git diff, verify command, đọc transcript chạy **ngoài** Thread lease và Graph lease.
7. **Context là untrusted model input.** Section `delegations` trong handoff là dữ liệu; policy không đọc nó.
8. **Không fabricate.** Bridge `partial` ⇒ evidence `derived`; `unsupported` ⇒ `unknown`; usage không parse được ⇒ `null` + completeness.
9. **Runtime = f(model).** Không phase nào thêm cách chọn runtime.
10. **Không thư mục mới** (vision §9). File mới chỉ trong `src/execution/`, `src/runtime/`, `src/cli/commands/`.

## Phase

| Phase | Tên | Trạng thái |
|---|---|---|
| 1 | [Approval hẹp (M3, prepare-time)](./phase-1-approval.md) — độc lập, chạy xen kẽ được | pending |
| 2 | [`writeScope`](./phase-2-write-scope.md) — mở đầu bằng đo precedence sandbox Claude | pending |
| 3 | [Evidence](./phase-3-evidence.md) — bridge cho child, git baseline, `verify.commands`, evaluator | pending |
| 4 | [Acceptance](./phase-4-acceptance.md) — `alp delegation accept\|reject`, nguồn thứ hai của projector | pending |
| 5 | [Runtime enforcement capabilities](./phase-5-enforcement-capabilities.md) — `measuredOn`, agent test tầng 2 | pending |
| 6 | [Usage telemetry + budget observe-only](./phase-6-usage.md) — parse từ transcript bridge đã mở | pending |
| 7 | [Launch provenance](./phase-7-launch-provenance.md) | pending |

Thứ tự bắt buộc: 2 → 3 → 4 (vòng governance). 1, 5, 7 độc lập; 5 nên trước 6 vì evaluator của 3 và usage của 6 đọc `policy.enforcement`. Ước lượng ≈ 5–7 tuần tuần tự (tham chiếu: graph 5 phase ≈ 1 tuần, Thread 6 phase ≈ 1 tuần).

## Gate

| Gate | Điều kiện | Mở gì |
|---|---|---|
| Governance loop đóng | Phase 2 + 3 + 4; `main` chạy delegate → wait → evidence → accept trên **cả hai** runtime | README/docs được nói "delegation có kiểm chứng" |
| `orchestrator` (vision §5.9) | Governance loop + Phase 5 + 6 (observe-only đủ) | Plan riêng cho role `orchestrator` — chỗ duy nhất bật "chặn settle root khi còn `undecided`" |
| Hard budget | ADR §Câu hỏi còn mở #1 | Phase 6b |
| Supervisor / policy pack | ≥2 project dùng governance loop thật với nhu cầu khác nhau | Roadmap kế tiếp |

## Phụ thuộc kế hoạch khác

| Quan hệ | Kế hoạch | Trạng thái |
|---|---|---|
| Cần | [Execution Graph](../260911-0623-execution-graph/plan.md) | done |
| Cần | [Thread as Unit of Work](../260911-1811-thread-unit-of-work/plan.md) — tái dùng `HistoryBridge`, `projectContext`, `history-redact` | done |
| Tái dùng | [Paseo permit ACL](../260903-1345-paseo-permit-acl/plan.md) — `permission-rules.ts` declarative | done |
| Không đụng | [Native Binary Distribution](../260907-2322-native-binary-distribution/plan.md) | chỉ thêm file dưới `<execution>/`, không đổi state layout |

## Rà đối kháng

Lượt 1 — 2026-09-12, review roadmap V1 → V2 → V3 đối chiếu code `main` (`ffa9706`). Tất cả **nhận**, đã lan xuống phase.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | CHẶN | V2 đặt telemetry vào P0 dù không nhánh governance nào phụ thuộc | Telemetry xuống Phase 6; 2→3→4 là xương sống |
| 2 | CHẶN | Acceptance không có producer; không guard ⇒ child tự chấp nhận mình | `alp delegation accept\|reject` qua `authenticateParent`; guard `acceptedBy === node.parentExecutionId` (P4) |
| 3 | CHẶN | Tool-call budget "hard" = đưa lại `PreToolUse` hook đã bỏ có chủ đích | Observe-only; hard tách ADR |
| 4 | CHẶN | "Verified" không có ALP-run verify thì chỉ là self-report | `verify.commands` trong `.alp/settings.json` lên Phase 3 |
| 5 | NÊN SỬA | Tool trace: nửa root đã có (`ThreadToolCallRef`, `ThreadChangeRef`); gap thật là child | Phase 3 chạy bridge cho child vào `<child>/context/history/`, không vào Thread `messages/` |
| 6 | NÊN SỬA | Git-observed changedFiles mơ hồ khi hai child cùng workspace | `ambiguousWith` từ overlap thời gian trên graph; `observed` chỉ khi rời nhau hoặc `writeScope` rời nhau (P3) |
| 7 | NÊN SỬA | Field thêm vào `ChildRequest` không có consumer; fingerprint liệt kê thiếu | Mỗi field đi cùng phase có consumer; "thêm vào" fingerprint, không viết lại danh sách; bỏ `stopConditions`, `outputRequirements` |
| 8 | NÊN SỬA | `supportsApproval` đặt trên runtime adapter; `PolicyDecision` thiếu `prompt`/`scope` | Trên surface (`interactive === true`); đủ `prompt`, `scope: once\|execution\|session` (P1) |
| 9 | NÊN SỬA | Provider capability không có ngữ cảnh đo (Windows không sandbox, số liệu theo version) | `measuredOn { platform, runtimeVersion, measuredAt }` (P5) |
| 10 | NÊN SỬA | `schemaVersion`, `ExecutionUsage` không version, không sizing/test strategy, §13 còn markdown source | `version: 1` + `V1`; §0/§8 V3; bỏ markdown |
| 11 | SỬA NHẬN ĐỊNH | Review V2 nói "root interactive không đo được usage" | Sai: bridge đã mở transcript có usage (Claude JSONL `message.usage`, Codex rollout `token_count`); child cũng không chạy `-p` (`adapter-files.ts:102`) nên transcript là đường duy nhất cho cả hai (P6) |

## Nhật ký kiểm chứng

### Lượt 1 — 2026-09-12 (principal uỷ quyền tự chốt)

| Câu hỏi | Chọn | Vì sao | Ảnh hưởng |
|---|---|---|---|
| Acceptance vào Thread context bằng pin hay nguồn thứ hai? | **Nguồn thứ hai** — section `delegations` trong checkpoint, do ALP sinh | Pin là agent-authored; acceptance là ALP-authored từ record xác thực. Trộn vào một danh sách là mất provenance ngay ở lớp context | P4 sửa `context-types.ts`, `context-projector.ts`, handoff render |
| Child chạm rule approval thì sao? | **`deny` (`APPROVAL_UNAVAILABLE`)** | `alp delegate` chạy dưới tool call, stdout về model, không có principal. Approval đi lên theo cây cần kênh riêng — M3 đầy đủ, ADR | P1 |
| Version lệch `measuredOn` ⇒ fail-closed? | **Không chặn launch**; evidence hạ `observed` → `derived`, `alp doctor` cảnh báo | Chặn = ALP chết mỗi lần CLI update. Hạ provenance là fail-closed đúng lớp | P5, evaluator P3 |
| `verify.commands` từ tầng nào? | **Project trở lên**, không user-global | Repo config chạy lệnh — chấp nhận vì agent đã chạy lệnh trong repo đó; user-global mở trust boundary khác | P3 |
| Field mới vào graph node: bump `version`? | **Không** — `acceptance`, `usage` optional, additive; `revision + 1` như mọi ghi | Quy ước: additive optional không bump; đổi nghĩa mới bump | P4, P6 |
| Launch provenance vào `policyHash`? | **Không** — ghi `<execution>/runtime/launch.json` sau policy | Là sự kiện, không phải quyết định | P7 |

## Câu hỏi còn mở

Không chặn plan; mỗi cái là một ADR khi có nhu cầu thật.

1. **Hard budget / per-call enforcement.** Cần `PreToolUse` hook trở lại; Codex không có hook tương đương ⇒ bất đối xứng; giá trị so với observe-only + reject chưa chứng minh.
2. **Approval đi lên theo cây cho child.** Cần graph node `pending-approval` + root TTY poll — M3 đầy đủ.
3. **Claude writeScope trên Windows.** Không sandbox ⇒ chỉ permission rules (không chặn Bash ghi file) hoặc `declared-only`. Chốt sau khi Phase 2 đo.
