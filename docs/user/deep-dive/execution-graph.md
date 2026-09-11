---
title: Execution graph
description: Cây của một phiên — quan hệ cha-con, trần, allowance, hạn và lý do huỷ, bền vững và process-safe.
---

> **Một câu:** Execution graph là **cây của một phiên**, và là nguồn sự thật logic cho mọi câu hỏi về quan hệ: ai là cha, sâu bao nhiêu, còn bao nhiêu lượt giao việc, hạn lúc nào, ai đã huỷ ai.

Một `graphId` là một cây, và nó **bằng đúng** execution ID của gốc. Cây sống ở `~/.alp/execution-graphs/<graph-id>.json` (mode `0600`), kèm một index tra ngược từ execution ID về cây chứa nó.

Cây là của **một lượt chạy**. Một việc kéo dài qua nhiều lượt là một [Thread](../thread/): mỗi root của Thread có cây riêng, và Thread chỉ ghi các root — con được uỷ quyền nằm trong cây của cha, không nằm trong Thread. Mỗi node mang `thread` — binding của root, con thừa kế nguyên văn (một con lệch binding cha là `THREAD_BINDING_MISMATCH`, cây bị từ chối lúc đọc); cây ghi trước khi có Thread đọc lên với `thread: null`.

## Hai loại thẩm quyền

| | Trả lời | Ở đâu |
|---|---|---|
| **Logical authority** | Ai là cha, còn bao nhiêu chỗ, hạn lúc nào, vì sao dừng | Cây |
| **Process authority** | pid nào còn sống, log ở đâu, exit code bao nhiêu | Backend store |

Tách hai thứ này ra là điều làm cho `cancel` có nghĩa: cây biết *phải giết những ai*, backend biết *giết bằng cách nào*.

## Một document, một revision

Mọi thay đổi đọc lại rồi ghi dưới một **inter-process lease**, và revision mới phải là `previous + 1`.

- Hai process cùng ghi → một cái thắng, cái kia nhận `EXECUTION_GRAPH_REVISION_CONFLICT`. Một lost update là **lỗi**, không phải một lần ghi đè im lặng.
- Không lấy được lease trong thời gian cho phép → `EXECUTION_GRAPH_LOCK_TIMEOUT`. Đợi vài giây rồi chạy lại; lease thuộc về một tiến trình `alp` đang sống.
- Document không parse được, hoặc parse được nhưng không thoả invariant → `EXECUTION_GRAPH_CORRUPT` / `EXECUTION_GRAPH_INVALID`. ALP **fail đóng**: không tự sửa, và không rơi về record cũ.

Không fallback là chủ ý: che một cây hỏng bằng dữ liệu cũ là cách một cây hỏng trở thành một cây vô hình.

## Trạng thái của một node

```text
preparing ──▶ queued ──▶ running ──▶ completed
    │            │          │   └───▶ failed
    │            │          └───────▶ cancelling ──▶ cancelled
    └────────────┴──────────────────▶ interrupted
```

Bốn trạng thái đầu là **đang sống**, bốn trạng thái sau là **kết thúc**, và chỉ những bước vẽ ở trên mới hợp lệ — một chuyển trạng thái ngoài bảng bị từ chối (`INVALID_NODE_TRANSITION`) chứ không được ghi đại.

`cancelling` tồn tại riêng vì một lý do: backend từ chối tín hiệu thì node **ở lại** `cancelling` cho tới khi reconciliation đóng nó. Không có node nào tự nhận `cancelled` trong khi process của nó vẫn đang chạy.

## Trần — cố định trong code

| Trần | Giá trị | Lỗi khi chạm |
|---|---|---|
| Độ sâu | `2` (gốc là 0) | `DEPTH_LIMIT_EXCEEDED` |
| Số con mỗi execution | `4` | `CHILD_LIMIT_EXCEEDED` |
| Con chạy đồng thời mỗi execution | `2` | `CONCURRENCY_LIMIT_EXCEEDED` |
| Execution sống đồng thời, cả cây | `6` | `GRAPH_CONCURRENCY_LIMIT_EXCEEDED` |
| Tổng lượt giao việc cả đời cây | `8` | `DELEGATION_LIMIT_EXCEEDED` |
| Tuổi thọ của cây | 2 giờ | `WALL_CLOCK_EXCEEDED` |

**Không có khoá config nào mở chúng.** Sửa trần là sửa code, và đi qua review — đó chính là điểm.

Allowance đếm theo **lượt**, không theo số node đang sống: một việc đã xong vẫn tiêu một lượt trong `8`. Một request bị policy từ chối thì không tiêu lượt nào, vì nó bị chặn trước khi chạm tới cây.

:::note[Trần này đếm execution, không đếm token]
Token budget và tool-call budget **không** có trong ALP hôm nay. Trần ở trên nói về số lượt và số tiến trình, không nói về thứ chúng tiêu.
:::

## Reservation: chỗ được giữ trước khi có file

Một chỗ được giữ **trước** khi có bất kỳ file nào, và giữ cho tới khi backend đăng ký xong process. TTL 2 phút.

Đó là thứ làm cho trần đồng thời đúng khi bốn tiến trình cùng xin con một lúc — và làm cho một caller bị `kill -9` không để lại một slot khoá vĩnh viễn.

Vì vậy `alp delegation tree` có thể in `1 slot(s) held` mà bạn chưa thấy node tương ứng: một chỗ đã giữ, process chưa kịp sinh ra. Vài giây là bình thường.

## Reconciliation: cây hỏi lại thực tế

Trước **mỗi** lần giao việc, cây hỏi backend từng node còn sống có process thật không, rồi:

- node mà process đã biến mất → đóng với `EXECUTION_INTERRUPTED`;
- node `queued` quá thời gian ân hạn khởi động mà chưa thành process → `EXECUTION_NEVER_STARTED`;
- reservation quá hạn → thu hồi.

Một lần reboot vì thế không để lại một cây đầy node `running` ma từ chối mọi việc tiếp theo.

## Deadline tuyệt đối

Gốc chốt **một** timestamp. Mọi node và mọi tiến trình trong cây kế thừa **đúng** timestamp đó — không cộng dồn, không gia hạn, không làm mới khi giao việc mới.

Quá hạn thì cả cây bị huỷ với `WALL_CLOCK_EXCEEDED`, và `tree` ghi `terminationReason: "deadline"`.

| | `--timeout-ms` | Hạn của cây |
|---|---|---|
| Là gì | Một lần `wait` chịu đựng bao lâu | Mốc tuyệt đối của cả phiên |
| Hết giờ thì | Caller bỏ cuộc, execution **vẫn chạy** | Execution **phải chết** |
| Gia hạn được? | Truyền số khác cho lần `wait` sau | Không. Mở phiên mới |

## Cascade cancellation

`alp delegation cancel` khoá nhánh trước khi gửi tín hiệu, thu hồi mọi reservation trong nhánh, rồi báo **từ thế hệ sâu nhất lên**.

- Node được hỏi mang lý do `USER_REQUEST`.
- Con cháu mang `PARENT_CANCELLED` kèm execution ID của node đã chết — nên đọc `tree` là biết ai kéo ai xuống.
- Anh em ở nhánh khác **không** bị đụng.

## Secret không thành trạng thái bền

Cây chỉ giữ **SHA-256** của capability. Bản thân capability sống trong môi trường của tiến trình sở hữu nó và không có mặt trong graph, `policy.json`, `state.json`, log, result, hay output của bất kỳ lệnh nào.

Đường duy nhất nó chạm đĩa là supervisor spec của background spawn — file `0600`, bị `unlink` **trước** khi runtime được spawn.

`alp delegation tree` cũng không in capability hash, request fingerprint hay reservation ID: chúng không giúp người đọc, và một thứ đã in ra là một thứ đã đi vào log của ai đó.

## Đọc cây

```bash
alp delegation tree exec_abc123
```

```text
graph exec_main  ·  revision 7  ·  updated 2026-09-11T02:14:05.000Z
thread thread_k3x9  ·  context rev 1
deadline 2026-09-11T04:00:00.000Z
delegation 3/8 used  ·  5 remaining
nodes 4  ·  2 active  ·  1 slot(s) held
limits: depth ≤ 2  ·  4 children/execution  ·  2 concurrent children  ·  6 concurrent executions

main  ·  exec_main  ·  running
├─ search  ·  exec_search  ·  failed  ·  req req_2  ·  CHILD_START_FAILED: runtime refused the task
└─ worker  ·  exec_worker  ·  cancelled  ·  req req_3  ·  USER_REQUEST · requested by principal  ←
   └─ search  ·  exec_grandchild  ·  cancelled  ·  PARENT_CANCELLED · requested by exec_worker
```

Nhận ID của **bất kỳ** node nào trong cây và luôn vẽ từ gốc xuống, đánh dấu `←` vào node được hỏi. Con xếp theo thời điểm tạo, hoà thì theo execution ID — nên hai lần đọc cho ra cùng một chuỗi byte.

Bốn dòng header gần như luôn là câu trả lời cho *"vì sao nó không giao thêm việc nữa"*. Dòng `thread` in `legacy-unthreaded` cho cây ghi trước khi có Thread — đó là một cây bình thường, không phải một cây hỏng.

## Mã lỗi

| Mã | Nghĩa |
|---|---|
| `PARENT_EXECUTION_REQUIRED` | Gọi từ ngoài một phiên ALP |
| `CAPABILITY_INVALID` | Capability không khớp hash của node |
| `PARENT_NOT_ACTIVE` | Cha đã kết thúc |
| `DEPTH_/CHILD_/CONCURRENCY_/GRAPH_CONCURRENCY_/DELEGATION_LIMIT_EXCEEDED` | Chạm trần tương ứng |
| `WALL_CLOCK_EXCEEDED` | Quá hạn tuyệt đối |
| `REQUEST_ID_CONFLICT` · `REQUEST_IN_PROGRESS` | Cùng ID khác việc · retry của việc đang chạy |
| `RESERVATION_NOT_FOUND` · `RESERVATION_EXPIRED` | Chỗ đã giữ không còn |
| `EXECUTION_GRAPH_LOCK_TIMEOUT` · `_REVISION_CONFLICT` | Tranh chấp ghi |
| `EXECUTION_GRAPH_CORRUPT` · `_INVALID` · `_NOT_FOUND` · `EXECUTION_NODE_NOT_FOUND` | Cây hoặc node không đọc được |

Ngoài ra có bốn mã **ghi lên node** chứ không ném ra: `ROOT_START_FAILED`, `CHILD_START_FAILED`, `EXECUTION_NEVER_STARTED`, `EXECUTION_INTERRUPTED`. Bạn gặp chúng khi đọc `tree`, không phải khi một lệnh thất bại.

## Kiểm chứng

```bash
alp delegation tree exec_abc123 --json
ls ~/.alp/execution-graphs/
```

Cây hỏng thì xem [Xử lý sự cố](../../reference/troubleshooting/#cây-execution-hỏng-hoặc-bị-khoá). Đừng sửa tay file cây để "cấp thêm chỗ": revision và invariant được kiểm lúc đọc.

## Liên quan

- [Delegation](../delegation/) — cái tạo ra node mới trong cây
- [Execution](../execution/) — một node tương ứng với cái gì trên đĩa
- [Thread](../thread/) — chuỗi các root, mỗi root một cây
- [Policy](../policy/) — vì sao deny xảy ra trước khi chạm tới cây
