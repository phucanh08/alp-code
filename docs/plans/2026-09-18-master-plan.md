# Master plan — hoàn thiện ALP trước khi ghép Supervisor

> **Status:** Draft · **Ngày:** 2026-09-18 · **Owner:** anhlp · Đọc cùng
> [§4.13 của vision](../alp-design-philosophy-and-vision.md#413-ba-tầng-trách-nhiệm-supervisor--lead--peer)
> và quyết định 12–15 ở §11.

Đây là roadmap, không phải implementation plan. Mỗi nhóm việc bên dưới sẽ có plan riêng theo
format của `docs/plans/` khi bắt tay làm; file này chỉ nói **làm gì, theo thứ tự nào, xong là
thế nào, và cố ý không làm gì**.

---

## 0. Đích

Một ALP mà:

1. `main` (Lead) và `worker` (Peer) làm việc với nhau bằng contract rõ — assignment có biên,
   outcome có cấu trúc, bất đồng có bằng chứng — chứ không bằng "làm cho xong";
2. một Supervisor bên ngoài (Hermes trước, tự dựng sau) điều khiển được **toàn bộ** vòng đời
   một phiên `main` chỉ qua CLI, không cần TTY, không chạm workspace;
3. hai issue đang mở (#24 relay cho con background, #26 commit handoff + bằng chứng) đóng
   trên đường đi, không phải song song với đường đi.

Thứ tự áp dụng theo quyết định 14: **Peer ≠ Worker → Cha ≠ Arbiter → Supervisor ≠ Lead.** Nhưng
nhóm 1 đi trước cả ba vì nó là nợ đang chảy máu và mọi nhóm sau đứng trên nó.

## 1. Nguyên tắc cho cả roadmap

- **Không đổi tên vai.** `main`, `worker`, và 4 specialist giữ tên. Chỉ đổi contract trong prompt,
  output, docs.
- **Không thêm primitive.** Mọi việc dưới đây là Delegation + Execution + Thread + Evidence ghép
  lại. Thấy cần primitive mới thì dừng và viết lý do vào §7 vision trước.
- **Không mở `.git` cho con.** Commit là hành vi có chủ ý của principal-đã-duyệt; đường đi là
  `main` xin duyệt → giao `worker` commit (#26a), không phải nới sandbox.
- **Không nới bảng limit** (`maxDepth 2`, `4/2/6/8`, 2h) trong roadmap này. Đụng tới là việc của
  `orchestrator`, có plan riêng, có lý luận riêng.
- **Mọi thứ Supervisor thấy được phải có trong ALP dưới dạng bản ghi**, không phải log stdout.
  Acceptance có `actor`, outcome có `disposition`, evidence có `tail`.
- Mỗi nhóm kết thúc bằng docs user + CHANGELOG + release; không gom ba nhóm vào một release.

## 2. Nhóm 1 — Đóng nợ đang mở (#24, #26)

Mục tiêu: Lead nhìn thấy đúng con đã làm gì, giao được việc commit, và con background không mất
`alp`.

| # | Việc | Chạm vào | Xong khi |
|---|---|---|---|
| 1a | **Commit handoff** — luật trong `src/agents/main.ts`: khi principal duyệt, `main` giao `worker` commit với message và scope cụ thể thay vì tự thử `git commit` rồi bị sandbox chặn; skill delegation + `docs/user/concepts/agents-and-authority.md` nói rõ `main` read-only là **thiết kế**, không phải lỗi | `main.ts`, skill `delegation`, docs user, troubleshooting | `main` không còn gọi `git commit` trong transcript thử nghiệm; docs có mục "vì sao main không commit" |
| 1b | **Evidence có nội dung** — `ThreadToolCallRef.result { digest, tail }` lấy từ `tool_result` ở cả hai history bridge (`claude-history-bridge.ts`, tương đương Codex); `alp delegation evidence` in summary + tail thay vì chỉ tên tool; `wait --json` mang cùng dữ liệu | bridge ×2, `delegate.ts`, docs `delegation.md` + reference CLI | Nhìn `evidence` biết con chạy test pass/fail mà không mở log file backend |
| 1c | **Relay cho con background** (#24) — executor tách khỏi vòng đời lệnh `delegate`: một process supervisor detached phục vụ relay cho mọi con còn sống của phiên, tự tắt khi cây không còn node sống hoặc root kết thúc | `relay-server.ts`, `delegation-service.ts`, `local-process-backend.ts`, doctor | Con `--background` gọi `alp context pin` / `alp delegate` thành công sau khi lệnh cha đã trả về; `alp doctor` không thấy process mồ côi sau khi root đóng |

Phụ thuộc: 1a và 1b độc lập; 1c độc lập nhưng nên đi sau 1b để có evidence kiểm chứng relay hoạt
động. Nhánh riêng cho từng việc, PR riêng.

Rủi ro chính ở 1c: hook `session-end` chạy trong process khác với executor (hook đi trước relay ở
`entry.ts`), nên "root kết thúc" phải được đọc từ execution graph, không từ tín hiệu process.

## 3. Nhóm 2 — Peer ≠ Worker

Mục tiêu: `worker` sở hữu outcome, không sở hữu nghĩa vụ hoàn thành. Đây là phép tách đầu tiên
của §4.13 và là phần **duy nhất** của SLP cần đổi prompt.

| # | Việc | Chạm vào | Xong khi |
|---|---|---|---|
| 2a | **Outcome có cấu trúc** — `state.json.output` mang `disposition: done \| blocked \| reopen-request \| dependency-request` + `reason` + `evidenceRefs`; thiếu disposition ⇒ `unknown` (không phải `done`). `wait`/`status`/`tree` in disposition; acceptance record ghi lại disposition tại thời điểm quyết | `state.json` schema (bump `schemaVersion`), `delegate.ts`, acceptance | Con trả `blocked` thì `main` thấy ngay trong `wait`, không phải đọc prose |
| 2b | **Assignment có biên** — `alp delegate` thêm `--exclude-scope <path>...` (bù cho `--write-scope`) và `--objective`/`--verification` thành trường riêng trong request thay vì trộn vào task text; policy từ chối scope chồng lấn giữa hai con đang sống | `delegate.ts`, `DelegationRequest`, invariants | Hai `worker` song song không thể cùng sở hữu một path; request có đủ 4 trường objective/owned/excluded/verification |
| 2c | **Contract Peer trong prompt** — `worker.ts`: kiểm premise trước khi làm; khi bằng chứng nói ngược thì trả `reopen-request` kèm bằng chứng thay vì làm theo; khi thiếu input thì `dependency-request`; không "cố cho xong". `main.ts`: đọc disposition trước khi đọc prose; `reopen-request` là dữ liệu để reconcile, không phải bất tuân | `worker.ts`, `main.ts`, house-rules, 4 specialist nếu cần | Fixture thử: task có premise sai ⇒ `worker` trả `reopen-request`, không sửa code |
| 2d | **Docs vai** — `agents-and-authority.md` viết lại theo ba tầng; bảng invariant §4.13 chuyển thành user-facing; `docs/delegation.md` mô tả disposition và assignment | docs user, `delegation.md` | Người đọc docs user biết `worker` được phép nói "không" và nói thế nào |

Phụ thuộc: 2a trước 2c (prompt cần chỗ để trả). 2b độc lập với 2a. 2d cuối.

Không làm ở nhóm này: specialist peer mới, thay đổi `delegatesTo`, thay đổi `maxDepth`.

## 4. Nhóm 3 — Bề mặt cho Supervisor bên ngoài

Mục tiêu: một process ngoài ALP (Hermes) chạy được vòng đời `main` từ đầu tới cuối mà không có
TTY, và mọi phán quyết của nó nằm trong bản ghi ALP. Đây là phép tách thứ ba (Supervisor ≠ Lead)
giải bằng cách **đặt Supervisor ra ngoài**, và là phần chuẩn bị cho phép tách thứ hai (Cha ≠ Arbiter)
khi có ca thật.

| # | Việc | Chạm vào | Xong khi |
|---|---|---|---|
| 3a | **Root headless** — `alp -p [--json] -- <prompt>` mở Thread mới và chạy một lượt không tương tác; `alp thread continue <id> -p [--json] -- <prompt>` cho lượt sau. Output JSON là bản ghi: thread id, execution id, outcome, disposition, evidence ref | `run-main.ts` (bỏ giả định interactive ở root), `thread-service.ts`, CLI | Script bash chạy được 3 lượt liên tiếp trên một Thread, không TTY |
| 3b | **Approval không TTY** — khi `main` cần duyệt (commit, scope ngoài mặc định, ...) mà không có TTY, lượt kết thúc với outcome `needs-approval` + payload mô tả cái cần duyệt; lượt sau nhận `--approve <token>`/`--deny` | `run-main.ts`, approval flow, thread record | Supervisor nhận được `needs-approval`, gọi lại với `--approve`, lượt tiếp tục đúng chỗ |
| 3c | **Acceptance có `actor`** — acceptance record ghi ai quyết: `execution:<id>` (cha) hay `principal` (qua Supervisor, xác thực bằng root headless). `assertAcceptable` giữ nguyên luật "chỉ cha" cho `main → worker`; chỉ thêm đường `principal` cho **root** execution | `acceptance.ts`, invariants, CLI `accept/reject` | Root execution có thể được principal accept/reject từ ngoài; child vẫn chỉ cha quyết |
| 3d | **Contract cho Supervisor** — một file docs `docs/supervisor-contract.md`: những lệnh Supervisor được dùng, những gì nó không được chạm (workspace, `.git`, state files), format JSON của 3a/3b, cách đọc evidence/tree; đây là spec để viết adapter Hermes | docs | Người viết adapter Hermes không cần đọc source |

Phụ thuộc: 3a trước 3b và 3c. 3d viết song song, chốt sau 3c.

Không làm ở nhóm này: adapter Hermes (nằm ngoài repo này), role Supervisor trong ALP, child session
bền nhiều lượt.

## 5. Thứ tự và cột mốc

```
Nhóm 1 ──► release v0.16   (#24, #26 đóng)
Nhóm 2 ──► release v0.17   (worker là Peer; agents-and-authority viết lại)
Nhóm 3 ──► release v0.18   (root headless + needs-approval + actor; supervisor-contract.md)
                 │
                 └─► ghép Hermes (repo khác) — bắt đầu chỉ khi v0.18 có tag
```

Trong một nhóm, các việc làm trên nhánh riêng và merge độc lập; nhóm sau **không** mở nhánh khi
nhóm trước còn PR chưa merge. Cột mốc là tag, không phải "gần xong".

## 6. Cố ý không làm trong roadmap này

| Việc | Vì sao | Mở lại khi |
|---|---|---|
| Đổi tên `main`/`worker` → `lead`/`peer` | Quyết định 12 | Không |
| Role Supervisor trong ALP | Quyết định 13; hai lỗ hổng runtime ở §4.13 | Điều kiện ở §8 vision: child session bền, relay background xong, ≥ 2 Lead song song thật |
| Mở `.git` / nới sandbox cho `main` | `main` read-only là thiết kế | Không; handoff qua `worker` (1a) |
| Nới `maxDepth` / `maxChildren` / `delegationLimit` | Chưa có role nào cần | Plan `orchestrator` |
| Specialist peer mới | Chưa có use case | Khi 2c cho thấy `worker` generic thiếu gì |
| Ba graph tách (work / execution / authority) như báo cáo SLP đề xuất | Execution graph + acceptance record đã đủ biểu diễn; tách là thêm primitive | Khi acceptance `actor` (3c) không đủ mô tả ai-quyết-gì |
| Context projection riêng cho từng Peer | `alp context` + pin đã là projection | Khi đo được Peer thừa context |
| Child session bền nhiều lượt (Thread cho con) | Mở lại chính vấn đề Supervisor-as-Agent | Cùng lúc với role Supervisor |

## 7. Tiêu chí "roadmap này xong"

- [x] #24, #26 đóng bằng PR liên kết tới mục 1a–1c (PR #29, #30, #31).
- [ ] `alp delegation wait --json` trả `disposition`; fixture premise-sai trả `reopen-request`.
- [ ] Một script không TTY chạy: mở Thread → `needs-approval` → `--approve` → `worker` commit →
      principal accept root — toàn bộ chỉ qua `alp`, không sửa file nào bằng tay.
- [ ] `docs/supervisor-contract.md` tồn tại và adapter Hermes viết được từ nó.
- [ ] Vision §2 dòng "Mô hình trách nhiệm" đổi từ **Một phần** thành ✅.
