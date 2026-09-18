---
title: Delegation
description: Một vai nhờ vai khác làm việc — thứ tự thao tác, danh tính cha, và vì sao thứ tự đó không đổi được.
---

> **Một câu:** Delegation là đường **duy nhất** một vai nhờ vai khác làm việc, và nó chỉ bắt đầu sau khi cha đã được **xác thực** chứ không phải sau khi cha tự khai mình là ai.

Trang [Giao việc](../../guides/delegation/) nói cách dùng. Trang này nói cái đang chạy bên dưới, theo đúng thứ tự nó chạy.

## Một request gồm gì

```ts
{ requestId?, targetRole, task, workspace, workspaceMode?, metadata?, executionOptions? }
```

Chú ý cái **không** có: không `parentRole`, không `parentExecutionId`. Cha là ai được đọc từ [cây](../execution-graph/) sau khi capability thừa hưởng qua môi trường được kiểm — chứ không phải từ một trường mà bất kỳ ai gọi cũng điền được.

`ALP_ROLE=main alp delegate …` từng là toàn bộ chi phí để leo thang quyền. Giờ nó không còn là một câu có nghĩa.

## Thứ tự thao tác

```text
alp delegate review --project /path -- "Review the diff"
  → đọc binding từ env         4 biến, tất-cả-hoặc-không → thiếu: PARENT_EXECUTION_REQUIRED
  → graph.authenticateParent   capability so với hash trong cây; actor = agentId của node
  → normalizeRequest           validate, sinh requestId + executionId
  → ExecutionService.authorize DENY-FIRST — trước khi chiếm chỗ trong cây
  → graph.reconcileGraph       đóng node mà process đã chết, TRƯỚC khi tính trần
  → graph.reserveChild         depth · số con · đồng thời · allowance · deadline
  → ExecutionService.materialize  policy.json + state.json + identity capsule
  → adapter.prepare            launch spec + binding của con
  → backend.healthCheck
  → graph.startReservedChild(backend.spawn)   ← spawn DƯỚI lease của cây
  → nếu không --background: wait(executionId)
```

Ba chỗ trong thứ tự này không đổi được, và mỗi chỗ trả lời một câu hỏi cụ thể:

1. **Xác thực trước mọi thứ.** Không có binding thì không có cha, và không có cha thì không có gì để đứng dưới.
2. **Authorize trước reservation.** Một request bị policy từ chối không được giữ một slot đồng thời — dù chỉ trong khoảng thời gian nó mất để bị từ chối — và backend không được health-check, nên một request trái quyền không học được gì về hạ tầng bên dưới.
3. **Spawn dưới lease.** Nhả lease trước khi backend có record là mở một cửa sổ mà cây nói "đang chạy" còn process thì chưa tồn tại; một `cancel` rơi vào cửa sổ đó không tìm thấy gì để giết.

## Bốn biến binding

| Biến | Nội dung |
|---|---|
| `ALP_EXECUTION_GRAPH_ID` | Cây nào |
| `ALP_DELEGATION_EXECUTION_ID` | Node nào trong cây đó |
| `ALP_EXECUTION_CAPABILITY` | Bí mật chứng minh process này *là* node đó |
| `ALP_EXECUTION_DEADLINE_AT` | Hạn tuyệt đối của cả cây |

**Tất-cả-hoặc-không**: thiếu một biến là không có binding, không phải có một binding thiếu. Capability của con **dẫn xuất** từ capability của cha bằng HMAC, chứ không random — một retry của cùng một request phải ra đúng giá trị cũ, nếu không thì process mất bản ghi trong bộ nhớ sẽ không còn quyền kết thúc chính con nó đã đẻ.

:::caution[Đừng tự đặt bốn biến này]
Chúng là **danh tính** một execution được ALP cấp, không phải cấu hình. Đặt tay chỉ đổi lỗi thành `CAPABILITY_INVALID`.
:::

## `delegatesTo` cho phép, `reportsTo` chỉ mô tả

Hai trường này hay bị đọc như một cặp đối xứng. Chúng không phải:

- `delegatesTo` là **nguồn quyền duy nhất**. `target ∈ actor.delegatesTo` là câu hỏi policy thật sự hỏi.
- `reportsTo` chỉ mô tả kết quả đi về đâu trong sơ đồ tổ chức. Nó **không** cấp quyền gọi lên trên, và cũng không cấp quyền đọc private memory của bên kia.

Một vai `reportsTo: "main"` không vì thế mà gọi được `main`.

## Idempotency: `requestId` và fingerprint

Hai câu hỏi khác nhau, nên hai giá trị khác nhau:

- **fingerprint** trả lời *"việc gì"* — băm từ vai đích, task, workspace, mode, các tuỳ chọn và metadata, với khoá JSON đã sắp xếp ở mọi tầng.
- **`requestId`** trả lời *"lần gọi nào"*.

Gọi lại cùng `requestId` với **cùng** fingerprint là một retry: bạn nhận lại execution cũ (`REQUEST_IN_PROGRESS` kèm ID để chờ), không phải một execution thứ hai. Cùng `requestId` với fingerprint **khác** là `REQUEST_ID_CONFLICT` — một lỗi, vì hai việc khác nhau đang mang cùng một cái tên.

Nấc nằm trong fingerprint vì nấc quyết định model: cùng một câu hỏi ở `puck` và ở `ultra` là hai việc khác nhau.

## Foreground, background, và cái `wait` thật sự làm

`--background` trả về `executionId` ngay; execution do supervisor giữ, nên tiến trình `alp` kết thúc không làm nó biến mất.

Foreground chỉ là background cộng một lần `wait`. Vì vậy `--timeout-ms` là thời gian **một lệnh `wait`** chịu đựng — hết giờ thì caller bỏ cuộc (`EXECUTION_TIMEOUT`) còn execution nền **vẫn chạy**. Muốn nó dừng thì `cancel`, và đó là hai việc khác nhau một cách có chủ ý.

Hạn của cả phiên thì ngược lại: một mốc tuyệt đối, quá mốc là execution phải chết (`WALL_CLOCK_EXCEEDED`). Xem [Execution graph](../execution-graph/#deadline-tuyệt-đối).

## Kết quả được hoà giải, không lấy bừa

Khi backend báo terminal, service đọc `state.json`: **output đã validate của ALP thắng**, kết quả thô của backend chỉ là fallback khi state không đọc được. Spawn hỏng nửa chừng được ghi `failed` và **không retry** — một retry tự động sau spawn là cách tạo ra execution trùng mà không ai đếm.

## Lifecycle và legacy

`tree`/`status`/`wait`/`cancel`/`cleanup` hỏi cây trước. Chỉ khi cây trả lời *"không có node nào cho ID này"* thì mới rơi về record legacy (execution tạo trước khi có execution graph).

Cây **hỏng** thì không rơi về legacy — một fallback che lỗi cây là cách một cây hỏng trở thành một cây vô hình. `tree` không có đường lui đó: execution cũ trả `EXECUTION_NOT_FOUND`.

Legacy store từ nay **chỉ còn được đọc**: không record mới nào ghi vào đó, không migration, không xoá gì.

## Vòng nghiệm thu: bằng chứng có nguồn gốc

:::caution[Preview, chưa có trong stable v0.14.0]
:::

`state.json.output` của con là **self-reported**. Vòng nghiệm thu (xem [Giao việc](../../guides/delegation/#giao-việc-có-phạm-vi-và-bằng-chứng)) thêm ba thứ ALP tự quan sát, và mỗi thứ đi kèm **nguồn** và **độ tin**:

| Item | Nguồn | Độ tin cao nhất | Điều kiện |
|---|---|---|---|
| `change` | `git` (so với baseline chụp lúc `materialize`) | `observed` | không node nào khác có thể đã ghi cùng workspace **và** runtime cưỡng chế được write isolation |
| `change`, `tool-call` | transcript của chính runtime | `observed` / `derived` | transcript đọc trọn (`complete`) ⇒ `observed`; đọc thiếu ⇒ `derived` |
| `verify` | ALP chạy lệnh verify đã được trust | `observed` | chưa trust ⇒ `verify-skipped`, `unknown` |
| `output` | con tự khai | `self-reported` | không bao giờ thoả mục nào |
| `usage`, `budget` | transcript | — | cột đếm không được là `null`, không phải 0; `null` lan qua phép cộng |

Runtime thật (`launch.json`) khác version đã đo thì mọi `observed` hạ xuống `derived`. Evidence chỉ được thu ở `wait`, `evidence`, và ngay trước `accept|reject` — không bao giờ ở `status`/`tree`/`cancel`, vì thu là *chạy lệnh verify trong workspace* và một câu hỏi đọc không được kéo `npm test`.

`accept|reject` là hành động được **xác thực** như `delegate`: binding cha từ env, request phải là con trực tiếp (`ACCEPTANCE_NOT_PARENT`), con đã terminal (`ACCEPTANCE_SUBJECT_RUNNING`), quyết đúng một lần (`ACCEPTANCE_ALREADY_DECIDED`). Ba guard chạy trước khi thu evidence. Phán quyết ghi lên node (`acceptance = { decision, evidenceDigest, decidedAt }` — status của con **không** đổi; một con `failed` được `accept` vẫn `failed`) và vào record dưới thư mục **cha**, rồi vào Thread context như nguồn thứ hai, tách khỏi pin của agent: pin là agent viết, phán quyết là ALP viết từ record đã xác thực.

## `alp` bên trong sandbox: relay về process root

:::caution[Preview, chưa có trong stable v0.14.0]
:::

Sandbox của runtime chặn ghi `~/.alp`, nên một `alp delegate` gõ từ *trong* execution không thể tự đọc state, giữ lock hay sinh con. Từ 2026-09-18 nó **không thi hành gì cả**: thấy `ALP_RELAY_DIR` là chuyển nguyên argv thành một file request trong `<execution>/relay/` (thư mục duy nhất sandbox mở cho ghi), rồi đợi file response. Process root — thứ đang chạy `alp` thật ngoài sandbox — chạy lại đúng lệnh đó với binding của **execution vừa hỏi**, không phải của root, và chỉ nhận `delegate`, `delegation *`, `context *`, `help`, `--version`.

Hệ quả bạn nhìn thấy:

- `alp thread show` hay `alp --mode low` từ trong một phiên bị từ chối (exit 2) — đó là allowlist, không phải lỗi cài đặt.
- Execution background không có relay: nó sống lâu hơn tiến trình phục vụ nó.
- Sau khi execution kết thúc, `relay/` rỗng; một `server.json` còn lại nghĩa là root vẫn đang chạy.
- Trong Codex, lệnh chạy qua `zsh -lc`; task chứa `()` mà không đặt trong dấu nháy sẽ bị zsh đọc thành định nghĩa hàm và `alp` không hề chạy — im lặng, exit 0. Nháy task lại.

## Kiểm chứng

```bash
alp delegation list
alp delegation tree exec_abc123
alp delegation status exec_abc123
```

Spawn thành công **không** đồng nghĩa task hoàn thành: sau `wait`, execution phải ở `completed`, `failed` hoặc `cancelled`.

## Liên quan

- [Execution graph](../execution-graph/) — trần, allowance, huỷ lan xuống
- [Execution](../execution/) — cái được tạo ra ở bước `materialize`
- [Policy](../policy/) — vì sao deny xảy ra trước probe và spawn
- [Giao việc](../../guides/delegation/) — hướng dẫn dùng, kể cả `--write-scope`, `--require-evidence`, `accept|reject`
