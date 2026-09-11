---
title: Hook
description: Ba hook nối runtime với ALP — identity vào trước turn 1, sổ sách lúc kết thúc, nhật ký compaction.
---

> **Một câu:** Hook là **ba script `.cjs`** mà ALP đăng ký vào runtime để identity tới được model, kết quả được ghi sổ, và mỗi lần compaction để lại một dòng.

Hook là chỗ ALP chạm vào một phiên **đang sống**. Mọi thứ khác — policy, capsule, launch spec — xảy ra trước khi có tiến trình.

## Ba hook

| Hook | Sự kiện | Việc |
|---|---|---|
| `session-boot.cjs` | `SessionStart` | Đưa identity + continuity vào context trước turn 1 |
| `session-end.cjs` | `Stop` | Ghi câu trả lời cuối vào `state.json`, đóng execution |
| `compact-record.cjs` | `PreCompact` / `PostCompact` | Nối một dòng vào `context/compact-events.jsonl` |

Hai hook đầu luôn được đăng ký. Hook thứ ba chỉ được đăng ký khi `ALP_COMPACT_BRIDGE=1` **và** adapter của runtime đó đã đo được rằng sự kiện tương ứng thật sự bắn.

## Fail-open, và vì sao

Cả ba hook fail-open: lỗi không bao giờ được phép làm chết phiên mà nó đang phục vụ.

- `session-boot` không đọc được identity → phiên vẫn khởi động, kèm cảnh báo `ALP identity not loaded: …` và lời nhắc chạy `alp identity sync`.
- `session-end` gặp lỗi sổ sách → ghi note, không chặn. Một lỗi ghi sổ không được phép nhốt một phiên đã làm xong việc.
- `compact-record` luôn `process.exit(0)`, kể cả khi journal read-only hoặc không tồn tại.

Điều này **không** làm yếu mô hình bảo mật, vì fail-closed đã xảy ra sớm hơn và ở chỗ khác: adapter viết những file này **trước** khi spawn, nên một file không ghi được sẽ làm `prepare()` hỏng và không tiến trình nào ra đời.

Riêng `session-boot` tách hai lần đọc: identity và continuity nằm ở hai `try` khác nhau, để một `continuity.md` hỏng không cướp mất identity của phiên.

## `session-boot` — identity đi trước

Hook này là **kênh duy nhất** identity và continuity đi qua, trên cả hai runtime. Nó ghi ra `hookSpecificOutput.additionalContext`, thứ cả Claude Code lẫn Codex CLI đều biến thành message role `developer` đứng trước lượt đầu của người dùng.

Hai nguồn identity, theo thứ tự ưu tiên:

1. `ALP_SESSION_CONTEXT` — file của chính execution này, do adapter pre-render. Có identity, invariant, policy context và workspace grant. Mọi phiên khởi động qua `alp` đều có.
2. `~/.alp/agents/<role>.md` — tài liệu vai tĩnh, cho đường native khi principal chạy thẳng `claude`/`codex`.

Đường (2) có một bài học: thư mục cài là artifact bị thay nguyên khối mỗi lần update, nên tài liệu identity sinh **trong đó** biến mất đúng lúc hook cần đọc. Vì vậy hook đọc `~/.alp/agents`, và chỉ thử chỗ cũ như phương án dự phòng.

Continuity nối vào sau, từ `ALP_CONTINUITY_CONTEXT`, và nó **tuỳ chọn theo cách identity thì không**:

| Tình huống | Phản ứng |
|---|---|
| Biến không đặt, hoặc file `ENOENT` | Im lặng — chuyện thường |
| File rỗng | Im lặng — execution mới chưa có pin nào |
| Đọc lỗi khác (thư mục, quyền) | Cảnh báo |
| Vượt 24 KiB | Bỏ qua + cảnh báo |

24 KiB là **đúng** ngưỡng `renderContinuity` tự áp. Chỉ có một giới hạn injection, nên một file vượt nó là một file không ra từ renderer đó — và do đó không đáng tin.

`SessionStart` cũng bắn với `source="compact"` sau khi runtime tự nén. Hook chạy **nguyên như vậy** cho mọi `source`, không rẽ nhánh: đó chính là điểm cả hai runtime đồng ý về chỗ reinject, nên một nhánh riêng chỉ tạo ra hai đường code làm cùng một việc.

## `session-end` — chỉ làm sổ sách

Hook này **không** phán xét câu trả lời.

Trước đây nó parse message cuối thành JSON và trả `{"decision":"block"}` khi parse hỏng — tức là ép mọi vai nói JSON, kể cả vai nói chuyện trực tiếp với người. Vai giờ trả văn xuôi, nên việc còn lại chỉ là: lấy output, gọi `finalizeExecution`, ghi vào `state.json` để `run-main` và delegation service đối chiếu sau.

Nó lấy output từ trường đầu tiên có mặt trong: `last_assistant_message` → `output` → `final_output` → `result`. Bốn tên cho cùng một thứ, vì hai runtime và các phiên bản của chúng không gọi nó giống nhau.

### Kiểm tra chống giả mạo

Trước khi ghi bất cứ thứ gì, `finalizeExecution` dựng **lại** policy từ definition, workspace, mode, mode profile và `createdAt` — rồi so sánh với `policy.json` trên đĩa. Lệch một byte là `execution policy snapshot is invalid or stale`.

Hai lần lỗi thật đã dạy ra hình dạng hiện tại của hàm này:

- `mode` từng bị mặc định thành `medium` thay vì mang theo từ policy → **mọi** execution chạy trên nấc khác đều trượt kiểm tra, và Stop hook lặng lẽ bỏ cuộc.
- Mode profile từng không được nạp lại → mọi execution khởi động dưới một `settings.json` override đều trượt.

Cả hai chỉ lộ ra ở lần chạy thật đầu tiên.

Với **custom agent**, definition không có trong registry, nên hook resolve nó **theo hash** chứ không theo trust: trust có thể bị thu hồi giữa lúc launch và lúc Stop, còn execution đang kết thúc thì đã chạy với definition mà nó đã chạy. Một hash không còn khớp thứ gì trên đĩa là một definition bị đổi giữa chừng — đáng để fail.

### Rồi mới tới workflow

Workflow còn `running` được đẩy tới state cuối, output nộp vào contract, trạng thái mới ghi atomic (`0600`). Đã `completed` thì không làm gì; đã `failed` thì trả `output repair budget exhausted`.

## `compact-record` — zero dependency

Hook này ghi **một** dòng JSON và không làm gì khác: không normalize, không đọc lại journal, không chạm `checkpoint.json` hay `continuity.md`. Việc chuẩn hoá thành `CompactEventV1` xảy ra sau, trong TypeScript với Zod, lúc `alp context status|validate` replay journal.

Không phụ thuộc gì là chủ ý: file này không có đồ thị dependency để mà regress, và lõi của nó vẫn là một `appendFileSync`.

Bốn lớp bảo vệ:

| Bảo vệ | Giá trị |
|---|---|
| stdin tối đa | 1 MiB — vượt thì ghi `parseError`, không ghi nội dung |
| một dòng tối đa | 16 KiB — vượt thì bỏ dòng |
| một giá trị tối đa | 256 ký tự |
| key được giữ | whitelist theo runtime |

Whitelist: Claude `session_id, trigger, model, prompt_id, agent_id, agent_type`; Codex giống hệt nhưng `turn_id` thay `prompt_id`. **Mọi** key khác bị bỏ.

`phase` và `runtime` lấy từ **argv** do adapter truyền, không lấy từ payload. Tin vào payload về phase của chính nó là để nó tự chọn xem nó rơi vào thùng nào.

Lỗi parse chỉ ghi **tên** lỗi, không bao giờ ghi nội dung đã parse hỏng — payload có thể chứa prompt của người dùng.

Không có execution ID hợp lệ, không có policy hash, hoặc không có đường dẫn journal → hook im lặng thoát. Một phiên native chưa từng đi qua `alp` không phải là lỗi.

## Kiểm chứng

```bash
tail -3 ~/.alp/executions/exec_abc123/context/compact-events.jsonl
alp context validate exec_abc123
jq '.status, .workflow' ~/.alp/executions/exec_abc123/state.json
```

## Liên quan

- [Runtime và launch spec](../runtime/) — nơi ba hook được đăng ký
- [Checkpoint và continuity](../continuity/) — thứ journal này phục vụ
- [Execution](../execution/) — `state.json` mà Stop hook ghi
- [Workflow](../workflow/) — contract mà output phải qua
