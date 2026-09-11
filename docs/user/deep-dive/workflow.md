---
title: Workflow
description: Máy trạng thái tuyến tính của một vai — state nào mở tool nào, output contract, và một lần sửa duy nhất.
---

> **Một câu:** Workflow là **máy trạng thái tuyến tính** của một vai: nó quyết định vai đang ở bước nào, bước đó mở những tool nào, và câu trả lời cuối phải có hình gì.

Workflow không phải là một "quy trình khuyến nghị" viết trong prompt. Nó là dữ liệu trong definition, và mọi câu hỏi *"vai này giờ được dùng tool gì"* đều đọc từ nó.

## Tuyến tính, có chủ ý

`defineLinearWorkflow(id, states)` nhận một danh sách state và nối chúng thành một chuỗi: mỗi state có đúng **một** đích kế tiếp, state cuối là `terminal` và không khai transition nào.

Không có nhánh, không có vòng lặp, không có "quay lại bước 2". Một workflow rẽ nhánh là một workflow mà bạn phải mô phỏng trong đầu để biết vai đang có quyền gì; một chuỗi thì đọc một lần là biết.

Runner từ chối một definition sai ngay lúc khởi tạo: initial state không tồn tại, transition trỏ tới state không có, hoặc một state `terminal` lại khai transition — đều là `throw`, không phải warning.

## Sáu trạng thái chạy

| Status | Nghĩa |
|---|---|
| `running` | Đang ở một state không phải cuối; tool của state đó mở |
| `awaiting-output` | Đã tới state cuối; chờ nộp output |
| `repairing` | Output nộp vào không hợp lệ, còn đúng một lượt sửa |
| `completed` | Output hợp lệ |
| `failed` | Output vẫn không hợp lệ sau lượt sửa |
| `cancelled` | Bị huỷ khi còn đang sống |

Ba luật cứng trong runner:

- `transition` chỉ chạy khi `running`. Đang `awaiting-output` mà đòi đi tiếp là lỗi, không phải no-op.
- `submitOutput` chỉ chạy khi `awaiting-output` hoặc `repairing`.
- `cancel` chỉ chạy trên ba trạng thái sống; huỷ một thứ đã `completed` là lỗi.

## Tool mở theo state, không theo vai

`isToolAllowed` trả `true` chỉ khi **cả hai** đúng: status là `running`, và tool nằm trong `allowedTools` của state hiện tại.

Nên tập tool thực tế của một execution là **giao** của hai thứ:

```text
allowedTools(execution) = capabilities.tools (definition) ∩ allowedTools (state hiện tại)
```

Hệ quả trực tiếp: state cuối của **mọi** vai có sẵn khai `allowedTools: []` — `REPORT`, `RECOMMEND`, `HANDOFF`, `TITLE`. Giai đoạn viết câu trả lời không phải lúc còn chạy thêm lệnh, và điều đó được cưỡng chế chứ không phải được nhắc.

`titling` đẩy điều này tới cực đoan: workflow của nó có đúng một state, state đó là cuối, nên execution vào thẳng `awaiting-output` mà không bao giờ ở `running`. Một vai chỉ đặt tên cho thread thì không cần quyền đọc gì cả.

## Workflow của các vai có sẵn

| Vai | Workflow ID | Chuỗi state |
|---|---|---|
| `main` | `coordinate-principal-task` | ASSESS → PLAN → DELEGATE → VERIFY → REPORT |
| `worker` | `execute-delegated-task` | ASSESS → IMPLEMENT → VERIFY → REPORT |
| `search` | `retrieve-code` | VALIDATE_WORKSPACE → RETRIEVE → VERIFY → REPORT |
| `review` | `review-concern` | SCOPE_CONCERN → INSPECT → VERIFY → REPORT |
| `librarian` | `research-sources` | SCOPE → RESEARCH → CORROBORATE → REPORT |
| `read-thread` | `retrieve-memory` | PARSE_QUERY → RETRIEVE → VERIFY → REPORT |
| `oracle` | `advise` | FRAME → CHALLENGE → EVALUATE → RECOMMEND |
| `compaction` | `compact-context` | EXTRACT → SEPARATE_FACTS → PRESERVE_ANCHORS → HANDOFF |
| `titling` | `title-thread` | TITLE |

Đọc kỹ hai dòng đầu thì thấy toàn bộ mô hình quyền lực của ALP:

- `main` **không bao giờ** mở `Write` hay `Edit` ở bất kỳ state nào. `DELEGATE` mở `Bash` — đó là cách nó gọi `alp delegate`, không phải cách nó sửa file.
- `worker` chỉ mở `Write`/`Edit` ở đúng một state, `IMPLEMENT`. Sang `VERIFY` là mất quyền ghi, nên "verify" không thể lặng lẽ biến thành "sửa thêm một chút".

## Output contract

State cuối không kết thúc bằng "vai nói xong". Nó kết thúc bằng một giá trị đi qua `contract.validate()`.

**Cả chín vai có sẵn dùng `textOutput`**: một chuỗi không rỗng sau khi trim, đặt tên theo thứ nó trả về — `principal-response`, `task-result`, `code-review-report`, `research-report`, `code-search-result`, `memory-retrieval-result`, `architecture-advice`, `context-handoff`, `thread-title`. Sai thì đúng một issue: `output must be non-empty text`.

Đây là một quyết định đã đổi. Trước đây Stop hook parse câu trả lời cuối thành JSON và chặn phiên khi parse hỏng — tức là ép **mọi** vai nói JSON, kể cả vai nói chuyện trực tiếp với người. Vai giờ trả văn xuôi, và hook chỉ còn làm sổ sách.

Contract có cấu trúc vẫn là công dân hạng nhất: `defineOutputContract(name, zodSchema)` sinh ra contract đóng băng kèm JSON Schema, và issue được format thành `<path>: <message>` (ví dụ `summary.title: Required`). Đơn giản là không vai có sẵn nào cần tới nó hôm nay.

## Đúng một lượt sửa

```text
MAX_OUTPUT_REPAIR_ATTEMPTS = 1
```

Nộp sai lần đầu → `repairing`, `repairAttempts` thành 1. Nộp sai lần nữa → `failed`, và số lần thử **không** tăng thêm.

Một lượt, không phải ba, vì lý do thực tế: nếu lần sửa đầu đã không đưa được output về đúng hình, những lần sau hầu như chỉ đốt thêm thời gian và token cho cùng một hiểu nhầm. `failed` sớm là một tín hiệu đọc được; một vòng lặp sửa thì không.

## Workflow và execution state

`StoredExecutionState.workflow` giữ đúng bốn trường: `workflowId`, `currentState`, `status`, `repairAttempts`. Mỗi snapshot là một object đóng băng mới — runner không mutate tại chỗ, nên hai lần đọc cùng một state không thể khác nhau.

Stop hook là nơi workflow đi tới đích: nó đẩy workflow còn `running` tiến lên tới state cuối (`advanceToOutput`), rồi nộp câu trả lời cuối cùng vào contract. Nếu một state trên đường đi không có đúng một transition, hook dừng và báo lỗi thay vì đoán.

## Kiểm chứng

```bash
alp agent show worker          # workflow và allowedTools từng state
alp context status exec_abc123 # state và status hiện tại của một execution
```

## Liên quan

- [Agent](../agent/) — nơi workflow được khai
- [Capability](../capability/) — nửa còn lại của phép giao tool
- [Execution](../execution/) — nơi workflow state được ghi xuống đĩa
- [Hook](../hook/) — Stop hook nộp output vào contract
