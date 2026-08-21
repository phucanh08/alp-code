# herdr — Bẫy đã kiểm chứng (L2)

> Mỗi mục dưới đây đã tự tay thử, không phải suy đoán từ docs.
> Kiểm chứng trên **0.8.0** trừ chỗ ghi rõ khác. Đọc khi gặp hành vi lạ.

## 0. herdr tự cập nhật giữa phiên — CLI đổi theo

herdr nhảy **0.7.4 → 0.8.0** (protocol 16 → 19) ngay giữa một phiên làm việc, không hỏi.
Lệnh đang chạy được bỗng trả `unknown option`. Những gì đã đổi:

| 0.7.4 | 0.8.0 |
|---|---|
| `herdr wait agent-status <pane> --status <s>` | `herdr agent wait <target> --until <s>` |
| `herdr wait output <pane> --match` | `herdr pane wait-output <pane> --match` |
| `herdr agent send <target> <text>` | `herdr agent prompt <target> <text> [--wait]` |
| `agent start <n> --cwd P --workspace W --split D -- argv` | `agent start <n> --kind K --pane ID -- args` |
| — | thêm `agent send-keys`, `agent read --source detection` |

**Quy tắc:** gặp `unknown option` / `unknown command` thì chạy `herdr --version` **trước**
khi debug. Và dòng tóm tắt trong `herdr <nhóm> --help` có lúc lệch với
`herdr <nhóm> <lệnh> --help` — tin cái sau, nó là clap parser thật.

## 0b. `agent start` cần pane đã ở dấu nhắc shell

Từ 0.8.0 nó không tự tạo pane nữa. Hai bước:

```bash
P=$(herdr pane split --pane <parent> --direction down --cwd <dir> --no-focus \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
herdr agent start <name> --kind claude --pane "$P" --timeout 60000 -- "<prompt>"
```

Thành công nghĩa là herdr **đã nhận diện được** agent đó trong pane (`interactive_ready: true`),
không chỉ là đã chạy lệnh.

## 1. `wait agent-status` chỉ bắt CHANGE, không bắt state hiện tại

```bash
# pane đang idle
herdr wait agent-status w3:p2 --status idle --timeout 1200
# → "timed out waiting for agent status change", exit 1
```

Nó chờ **sự kiện chuyển trạng thái**, không kiểm tra trạng thái hiện có. Chờ đúng cái state
mà pane đang mang = ngồi đến hết giờ.

**Cách đúng:** kiểm tra trước, chỉ chờ khi chưa khớp.

```bash
cur=$(herdr agent list | python3 -c '
import json,sys
print(next(a["agent_status"] for a in json.load(sys.stdin)["result"]["agents"]
           if a["pane_id"]=="w3:p2"))')
[ "$cur" = "idle" ] || herdr wait agent-status w3:p2 --status idle --timeout 300000
```

## 2. `--seq` không tăng → bỏ qua im lặng, exit 0

```bash
herdr pane report-agent w3:p2 --source pho --agent a --state idle    --seq 30   # ăn
herdr pane report-agent w3:p2 --source pho --agent a --state blocked --seq 30   # exit 0
herdr agent list   # → vẫn là state cũ. Không có cảnh báo nào.
herdr pane report-agent w3:p2 --source pho --agent a --state blocked --seq 31   # ăn
```

Đây là bẫy nguy hiểm nhất: panel sai mà exit code nói mọi thứ ổn. **Giữ một biến đếm dùng
chung suốt phiên**, `SEQ=$((SEQ+1))` trước mỗi lần báo. Đừng dùng timestamp giây — hai lần
báo trong cùng giây sẽ trùng.

## 3. Pipe nuốt mất exit code

```bash
herdr wait agent-status w3:p2 --status idle --timeout 1500 | head -c 300
echo $?     # 0 — của head, KHÔNG phải của herdr
```

Bắt exit code trước khi pipe:

```bash
herdr wait agent-status w3:p2 --status idle --timeout 1500 > /tmp/w.json 2>&1
rc=$?
```

## 4. `pane read` không giới hạn = nuốt cả buffer

`--lines` là van context duy nhất. Không có nó, herdr trả toàn bộ vùng đang xem —
với agent chạy lâu, đó có thể là hàng nghìn dòng.

`wait output` cũng vậy: kết quả JSON **nhúng cả `read.text`**. Luôn kèm `--lines 5`.

## 5. `agent send` không gửi Enter

| Lệnh | Gửi | Dùng khi |
|---|---|---|
| `agent send <t> "text"` | text thuần | trả lời prompt của agent |
| `pane run <p> "cmd"` | text + Enter | chạy lệnh shell |
| `pane send-keys <p> Enter` | phím | gửi Enter riêng |

Agent không phản ứng sau khi `agent send`? Nhiều khả năng nó đang chờ Enter.

## 6. `agent explain` chỉ chạy với agent herdr tự nhận diện

```
{"error":{"code":"agent_explain_unavailable",
          "message":"agent target X does not have a detected agent label"}}
```

Đây là hành vi đúng, không phải hỏng. Agent do Phở tự khai qua `report-agent` không có
"detected label" nên không giải thích được.

## 7. Nhiều `source` tranh nhau một pane

Bộ nhận diện của herdr **cũng là một source**. Phở báo `idle`, một lúc sau herdr tự phát hiện
tiến trình kết thúc và đặt `done` — state đổi "không rõ lý do".

- Muốn giữ quyền: tiếp tục báo với seq tăng dần.
- Xong việc: `pane release-agent --source pho --agent <label> --seq N` để trả quyền lại.

## 8. Tên event không thống nhất — kể cả trong cùng một stream

| Ngữ cảnh | Dạng tên |
|---|---|
| `events.subscribe` → `subscriptions[].type` | `pane.agent_status_changed` (chấm) |
| `events.wait` → `match_event.event` | `pane_agent_status_changed` (gạch dưới) |
| Event đẩy về: đổi trạng thái | `"event":"pane.agent_status_changed"` (chấm) |
| Event đẩy về: vòng đời pane | `"event":"pane_agent_detected"` (gạch dưới) |

Hai dòng cuối cùng nằm **trên cùng một kết nối**. Luôn chuẩn hoá trước khi so:

```python
name = ev.get("event", "").replace(".", "_")
```

## 8b. Mỗi kết nối chỉ `events.subscribe` được MỘT lần

Gửi request subscribe thứ hai trên cùng socket → **không ack, stream nghẽn luôn**, không có
lỗi nào trả về.

```python
snd({"id":"a","method":"events.subscribe","params":{...}})   # ack ✓
snd({"id":"b","method":"events.subscribe","params":{...}})   # im lặng, hỏng stream
```

Muốn theo dõi thêm pane → **đóng kết nối, mở lại với danh sách đầy đủ**. Sau khi kết nối lại
phải quét `agent list` một lượt để bù những chuyển trạng thái rơi vào khoảng trống.
`scripts/fleet-watch.py` trong skill `herdr` đã xử lý sẵn.

## 8c. `report-agent` không nhận `done`

```bash
herdr pane report-agent w3:p2 --source pho --agent x --state done
# Error: invalid pane agent state: done (expected idle, working, blocked, or unknown)
```

`done` là state herdr **tự suy ra** khi tiến trình kết thúc — nó có mặt trong rollup, trong
`wait --status done`, trong event; nhưng không phải thứ báo lên được.

Báo được: `idle` · `working` · `blocked` · `unknown`.

Hệ quả kèm theo: khi Phở đang giữ quyền một pane bằng `report-agent` với seq cao, `done` do
herdr phát hiện **bị đè**. Tiến trình chết mà panel vẫn hiện `working`. Xong việc thì
`pane release-agent` để trả quyền cho bộ nhận diện.

## 9. `pane.agent_status_changed` không có bản toàn cục

Bắt buộc `pane_id`. Theo dõi cả fleet = liệt kê từng pane trong mảng `subscriptions`.
Pane sinh sau đó **không tự vào stream** — bắt `pane.created` / `pane.agent_detected` rồi
gửi thêm `events.subscribe`.

## 10. zsh không tách từ biến

Không phải bẫy của herdr, nhưng đã cắn một lần khi viết script quét:

```zsh
c="pane list"; herdr $c        # → "unknown command: pane list"
c="pane list"; herdr ${=c}     # đúng, hoặc dùng mảng
```

## 11. `api snapshot` phình theo fleet

~440 token cho 2 pane. Với 20 pane thì đủ sức nuốt một phần đáng kể context.
Dùng `workspace list` (~45 tok/workspace, đã có rollup) cho mọi việc quét thường ngày.

## 12. `api schema --json` nặng ~235KB

Đừng bao giờ đọc thẳng vào context. Parse bằng python:

```bash
herdr api schema --json > /tmp/schema.json
python3 -c '
import json; d=json.load(open("/tmp/schema.json"))
print(json.dumps(d["schemas"]["request"]["$defs"]["AgentStartParams"], indent=1))'
```

## 13. Server không tự chạy

`herdr status server` báo `not running` thì mọi lệnh CLI đều thất bại. Khởi động headless:

```bash
herdr server >/dev/null 2>&1 &     # hoặc mở TUI: herdr
```

Dừng: `herdr server stop`.
