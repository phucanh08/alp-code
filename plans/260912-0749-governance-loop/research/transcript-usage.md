# Usage trong transcript hai runtime — đo 2026-09-17

Việc đầu tiên của P6: xác nhận hai định dạng trên đúng version bridge đã pin, trước khi viết
parser. Đo trên máy thật, transcript của chính các phiên đã chạy trong repo này.

## Claude Code — `2.1.268` (pin bridge `2.1`)

Nguồn: `~/.claude/projects/<slug>/<session>.jsonl`, 1 239 dòng `assistant`.

- Mỗi dòng `type: "assistant"` mang `message.id` (`msg_…`), `message.usage`, `requestId`,
  `apiBlockIndex`. **Một API response = nhiều dòng**: mỗi content block (`thinking`, `text`,
  `tool_use`) là một dòng riêng, cùng `message.id`, cùng `requestId`, **cùng `usage` y hệt**
  (đo: 377 message nhiều dòng, 0 message có usage khác nhau giữa các dòng). ⇒ cộng theo dòng
  là đếm đôi; phải **dedupe theo `message.id`**.
- `apiBlockIndex` có trên 100 % dòng assistant, dòng đầu của mỗi message luôn `0`. ⇒ khi
  cursor nằm giữa hai dòng của một message, dòng đầu tiên thấy được có `apiBlockIndex > 0` là
  dấu hiệu message này đã đếm ở lát trước — bỏ.
- `usage` (Anthropic Messages API): `input_tokens` **không** gồm cache; `cache_read_input_tokens`,
  `cache_creation_input_tokens` tách riêng; `output_tokens` gồm thinking
  (`output_tokens_details.thinking_tokens` là chi tiết, không cộng thêm). Các field khác
  (`iterations`, `server_tool_use`, `service_tier`, `speed`) bỏ.
- Dòng assistant tổng hợp lỗi (`isApiErrorMessage: true`) không có `message.id` lẫn `usage`
  — không phải một response, không tính, không hạ `unknown`.
- Tool call = block `tool_use`, đã thành entry `tool` của bridge. 823 block trong file đo.

Ánh xạ: `inputTokens = input_tokens`, `cacheReadTokens = cache_read_input_tokens`,
`cacheWriteTokens = cache_creation_input_tokens`, `outputTokens = output_tokens`.

## Codex CLI — `0.154.0` (pin bridge `0.154`)

Nguồn: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, 3 rollout 0.154.0 (10 / 14 / 41 event).

- Usage nằm ở `type: "event_msg"`, `payload.type: "token_count"`, `payload.info`:
  `total_token_usage` (**cộng dồn** cả session) và `last_token_usage` (lượt vừa rồi), mỗi cái
  `{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens,
  reasoning_output_tokens, total_tokens}`. Event đầu của session có `info: null` (chỉ
  `rate_limits`) — bỏ.
- `input_tokens` **gồm** `cached_input_tokens` (kiểu OpenAI `prompt_tokens`). ⇒ chuẩn hoá về
  cùng nghĩa với Claude: `inputTokens = input_tokens − cached_input_tokens`,
  `cacheReadTokens = cached_input_tokens`.
- `task_complete` phát lại một `token_count` **trùng** (cùng `total`, cùng `last`) ngay sau
  event cuối của lượt (2 trong 3 rollout; ở rollout thứ ba `Σ last ≠ total` chính vì thế).
  ⇒ trong một lát đọc, bỏ event có `total_token_usage` bằng đúng event trước nó; cộng `last`
  của phần còn lại. Với lát đầu (không có event trước) thì tin `last` — Σ last của các event
  không trùng = `total` cuối (kiểm trên cả ba rollout).
- Giới hạn: nếu cursor rơi đúng giữa cặp event trùng, lát sau đếm đôi một lượt. Cursor chỉ
  tiến lúc process đã thoát (`wait`/settle) nên cặp này luôn nằm trọn trong một lát; ghi nhận
  chứ không xử lý thêm.
- Tool call = `response_item` `function_call` / `custom_tool_call`, đã là entry `tool`.

## Kết luận cho parser

- `usageDelta` của bridge = tổng của **dòng mới sau cursor**, cùng luật version với entries:
  lệch pin vẫn parse, completeness `partial`. Không mở được transcript ⇒ `null` (không phải 0).
- Field nào không parse được (không phải số) ⇒ field đó `null` cho cả lát; cộng dồn giữ
  `null` (một lần không biết là không biết mãi — fail-closed cho budget).
- Bốn cột token tách riêng trong contract; `tokens` của budget so với **tổng bốn cột**
  (mọi token đã xử lý), vì "một lần đọc cache" vẫn là chi phí và vẫn là thứ trần muốn chặn.
- Fixture đã redact: `test/fixtures/transcripts/claude-usage.jsonl`, `codex-usage.jsonl`.
