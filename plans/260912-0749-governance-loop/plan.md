---
status: in-progress
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

**Ngoài phạm vi:** approval cho `--mode` (principal tự gõ flag); `verify.commands` tầng user-global; Supervisor / policy pack / workspace governance; M1 (surface/UI), M4; resume runtime session; `AssignmentContract`/`LaunchContract`/`assignmentId`/lease riêng; budget "hard" chặn tool call giữa chừng (ADR riêng); approval đi lên theo cây cho child (ADR riêng); ExecutionGraph thành DAG; >1 active root/Thread; steer message vào process; markdown làm nguồn config; role `orchestrator` (là gate mở *sau* plan này, không nằm trong).

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
10. **Không thư mục mới** (vision §9). File mới chỉ trong `src/execution/`, `src/runtime/`; CLI thêm subcommand vào `delegate.ts`/`agent-trust.ts`.

## Phase

| Phase | Tên | Trạng thái |
|---|---|---|
| 1 | [Approval hẹp (M3, prepare-time)](./phase-1-approval.md) — độc lập, chạy xen kẽ được | completed (2026-09-12) |
| 2 | [`writeScope`](./phase-2-write-scope.md) — mở đầu bằng đo precedence sandbox Claude | completed (2026-09-12) |
| 3 | [Evidence](./phase-3-evidence.md) — bridge cho child, git baseline, `verify.commands`, evaluator | completed (2026-09-17) |
| 4 | [Acceptance](./phase-4-acceptance.md) — `alp delegation accept\|reject`, nguồn thứ hai của projector | completed (2026-09-17) |
| 5 | [Runtime enforcement capabilities + launch receipt](./phase-5-enforcement-capabilities.md) — `measuredOn`, `launch.json`, agent test tầng 2 | completed (2026-09-12) |
| 6 | [Usage telemetry + budget observe-only](./phase-6-usage.md) — parse từ transcript bridge đã mở | pending |

Thứ tự bắt buộc: 2 → 3 → 4 (vòng governance). 1 và 5 độc lập; 5 nên trước 3 vì evaluator đọc `policy.enforcement` + `launch.json`. Ước lượng ≈ 5–6 tuần tuần tự (tham chiếu: graph 5 phase ≈ 1 tuần, Thread 6 phase ≈ 1 tuần). Không phase nào có thao tác khó đảo ngược cần hỏi principal trước khi chạy; `alp trust verify` là hành động của principal, không phải của phase.

## Gate

| Gate | Điều kiện | Mở gì |
|---|---|---|
| Governance loop đóng | Phase 2 + 3 + 4; `main` chạy delegate → wait → evidence → accept trên **cả hai** runtime | README/docs được nói "delegation có kiểm chứng" — **code đóng 2026-09-17** (P2+P3+P4 merged; e2e `test/e2e/acceptance.test.ts` chạy vòng trên fake binary); còn nợ chạy `main` thật trên Claude + Codex trước khi sửa README |
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
| Đã xong, cùng file | [Adapter: bỏ turn giả](../260903-0959-adapter-no-synthetic-turn/plan.md) — P2/P5 đụng `claude-adapter.ts`, `adapter-files.ts` | P0–P2 xong 2026-09-03; status đổi `completed` ở lượt 2 (P3 tầm nhìn giữ trong file) |

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

Lượt 2 — 2026-09-12, tự rà bốn lăng kính (kẻ tấn công, failure, phá giả định, phạm vi) trên draft đã commit `038608f`. Principal uỷ quyền tự quyết: **15 phát hiện, nhận 15, bác 0.** CHẶN 3 · NÊN SỬA 10 · GHI NHẬN 2.

| # | Mức | Lăng kính | Phát hiện | Xử lý | Áp vào |
|---|---|---|---|---|---|
| 1 | CHẶN | failure | `collectEvidence` "sau settle" không có điểm kích hoạt; settle qua `reconcileGraph` gọi từ `wait/status/tree/cancel` — treo vào reconcile thì `tree` chạy `npm test`; treo chỉ vào `wait` thì child background không bao giờ có evidence | Nhận: bảng điểm kích hoạt — `wait`, `alp delegation evidence`, `accept`; không bao giờ reconcile | P3, P4 |
| 2 | CHẶN | tấn công | `verify.commands` từ repo chạy bằng process ALP **ngoài** sandbox, full quyền user — clone repo lạ là RCE; lý do "agent đã chạy lệnh" sai vì agent chạy dưới sandbox | Nhận: chỉ chạy khi digest khối `verify` đã `alp trust verify` (tái dùng `src/trust/`); lệch ⇒ `verify-skipped untrusted` | P3 |
| 3 | CHẶN | giả định | Baseline `sha256(git status --porcelain)` không trừ được file dirty sẵn ⇒ quy nhầm cho child | Nhận: baseline lưu danh sách `{path, status, contentHash}` | P3 |
| 4 | NÊN SỬA | failure | `ambiguousWith` chỉ tính sibling, bỏ qua cha/ông active cùng workspace (`main` có Bash, read-only chỉ sandbox darwin/linux) | Nhận: overlap trên mọi node active; `writeIsolation ≠ enforced` ⇒ luôn vào | P3 |
| 5 | NÊN SỬA | giả định | Bảng provenance dùng `writeIsolation` cho cả `outsideScope` — hai câu hỏi khác nhau | Nhận: `outsideScopeVerified` theo `enforcement.writeScope` | P3 |
| 6 | NÊN SỬA | failure | Usage root: cursor do `collectHistory` tiến, gọi hai lần, không có nơi cộng dồn | Nhận: `ref.history.usage` cộng dồn cùng commit cursor | P6 |
| 7 | NÊN SỬA | giả định | Dựng `measuredOn` cho định dạng transcript trong khi bridge đã có `pinnedVersion` + `completenessForVersion` | Nhận: parser trong bridge dùng pinned version; `measuredOn` chỉ cho enforcement | P5, P6 |
| 8 | NÊN SỬA | tấn công | "Thêm `TOOL_CATALOG` cùng nhóm `alp delegate`" không tồn tại — `alp delegate` qua bare `Bash` allow; mọi role có Bash gọi được `accept` | Nhận: bỏ việc thừa; nói rõ guard là binding + cha-con; test role không có child ⇒ `ACCEPTANCE_NOT_PARENT` | P4 |
| 9 | NÊN SỬA | phạm vi | Rule `--mode ultra` hỏi lại chính người vừa gõ flag | Nhận: bỏ; P1 còn một rule | P1 |
| 10 | NÊN SỬA | phạm vi | P7 phase riêng cho receipt có consumer yếu, `runtimeVersion` P5 đã lấy | Nhận: gộp vào P5; còn 6 phase | P5, xoá P7 |
| 11 | NÊN SỬA | failure | Child bị cascade-cancel lúc root kết thúc cũng thành `undecided` ⇒ handoff đổ "cha quên" | Nhận: `decision: cancelled` derive từ node status | P4 |
| 12 | NÊN SỬA | giả định | Node có `endedAt`, plan viết `finishedAt` | Nhận | P3 |
| 13 | NÊN SỬA | tấn công | "`approvals.json` 0600 chỉ root đọc" — cùng OS user, 0600 không ngăn child; thứ ngăn là sandbox | Nhận: sửa lý do; P2 assert executions root ∉ `writable_roots`/`allowWrite` | P1, P2 |
| 14 | GHI NHẬN | phạm vi | Plan `adapter-no-synthetic-turn` `in-progress` nhưng P0–P2 xong 09-03; đụng cùng adapter file | Nhận: đổi `completed`; ghi vào phụ thuộc | plan adapter, plan.md |
| 15 | GHI NHẬN | giả định | `verify:<id>` fingerprint chỉ hash id; settings đổi lệnh vẫn cùng fingerprint | Nhận: item `verify` ghi `commandDigest` | P3 |

## Nhật ký kiểm chứng

### Lượt 1 — 2026-09-12 (principal uỷ quyền tự chốt)

| Câu hỏi | Chọn | Vì sao | Ảnh hưởng |
|---|---|---|---|
| Acceptance vào Thread context bằng pin hay nguồn thứ hai? | **Nguồn thứ hai** — section `delegations` trong checkpoint, do ALP sinh | Pin là agent-authored; acceptance là ALP-authored từ record xác thực. Trộn vào một danh sách là mất provenance ngay ở lớp context | P4 sửa `context-types.ts`, `context-projector.ts`, handoff render |
| Child chạm rule approval thì sao? | **`deny` (`APPROVAL_UNAVAILABLE`)** | `alp delegate` chạy dưới tool call, stdout về model, không có principal. Approval đi lên theo cây cần kênh riêng — M3 đầy đủ, ADR | P1 |
| Version lệch `measuredOn` ⇒ fail-closed? | **Không chặn launch**; evidence hạ `observed` → `derived`, `alp doctor` cảnh báo | Chặn = ALP chết mỗi lần CLI update. Hạ provenance là fail-closed đúng lớp | P5, evaluator P3 |
| `verify.commands` từ tầng nào? | **Project trở lên**, không user-global | Repo config chạy lệnh — chấp nhận vì agent đã chạy lệnh trong repo đó; user-global mở trust boundary khác | P3 |
| Field mới vào graph node: bump `version`? | **Không** — `acceptance`, `usage` optional, additive; `revision + 1` như mọi ghi | Quy ước: additive optional không bump; đổi nghĩa mới bump | P4, P6 |
| Launch provenance vào `policyHash`? | **Không** — ghi `<execution>/context/launch.json` sau policy | Là sự kiện, không phải quyết định | P5 |

### Lượt 2 — 2026-09-12

**Vì sao kiểm chứng:** rà đối kháng lượt 2 lộ bốn điểm plan đang đoán thay principal. Principal trả lời nguyên văn: *"Em hãy tự quyết nhé"* — uỷ quyền, em chọn phương án đề nghị ở cả bốn.
**Số câu hỏi:** 4

| Câu hỏi | Phương án | Chọn | Vì sao | Ảnh hưởng |
|---|---|---|---|---|
| [Rủi ro] `verify.commands` chạy với điều kiện gì? | a. qua trust store như agent definition · b. chỉ khi principal truyền `--verify` mỗi lần · c. giữ như plan | **a** | Tái dùng `src/trust/`; cùng mô hình "principal đã duyệt gì" theo digest; b làm `requiredEvidence` vô dụng khi cha là agent | P3 |
| [Phạm vi] P7 launch provenance? | a. gộp vào P5 · b. giữ riêng · c. bỏ | **a** | Cùng nguồn `runtimeVersion`; consumer yếu không đáng một phase | P5, xoá P7 |
| [Giả định] Child background mà cha không `wait` — evidence lấy lúc nào? | a. `accept\|reject` tự collect trước khi ghi · b. `settleRoot` collect mọi child thiếu · c. digest rỗng như plan | **a** | Record luôn có digest thật; b kéo verify vào đường settle root | P3, P4 |
| [Phạm vi] Plan `adapter-no-synthetic-turn` `in-progress`? | a. đổi `completed`, P3 tầm nhìn để nguyên · b. giữ, ghi `blocks/blockedBy` hai chiều | **a** | P0–P2 xong 09-03, P3 chưa mở khoá — không có việc đang chạy để chặn | plan adapter |

## Câu hỏi còn mở

Không chặn plan; mỗi cái là một ADR khi có nhu cầu thật.

1. **Hard budget / per-call enforcement.** Cần `PreToolUse` hook trở lại; Codex không có hook tương đương ⇒ bất đối xứng; giá trị so với observe-only + reject chưa chứng minh.
2. **Approval đi lên theo cây cho child.** Cần graph node `pending-approval` + root TTY poll — M3 đầy đủ.
3. **Claude writeScope trên Windows.** Không sandbox ⇒ chỉ permission rules (không chặn Bash ghi file) hoặc `declared-only`. Chốt sau khi Phase 2 đo.
4. **`verify.commands` tầng user-global.** Hiện chỉ project trở lên; nếu cần lint chung máy thì cần ADR về trust boundary riêng.
