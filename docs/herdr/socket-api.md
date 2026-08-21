# herdr — Socket API (L2)

> Đọc khi cần **event stream** hoặc gọi API không qua CLI.
> Việc thường ngày dùng CLI là đủ — CLI chính là client của socket này.
> Đã kiểm chứng trên herdr 0.8.0, protocol 19 (danh sách method lấy từ 0.7.4/protocol 16 —
> `herdr api schema --json` để đối chiếu lại nếu nghi ngờ).

## Kết nối

```
Unix socket: ~/.config/herdr/herdr.sock
Giao thức:   JSON Lines — mỗi request một dòng, mỗi response một dòng
```

**Request**
```json
{"id":"tuỳ-ý","method":"pane.read","params":{"pane_id":"w3:p2","source":"visible","lines":40}}
```

**Response** — một trong hai:
```json
{"id":"tuỳ-ý","result":{...}}
{"id":"tuỳ-ý","error":{"code":"invalid_request","message":"..."}}
```

`id` do client tự đặt, server trả lại nguyên văn. `params` **bắt buộc** kể cả khi rỗng.

Lấy schema đầy đủ: `herdr api schema --json` (~235KB — parse, đừng đọc thẳng).

## 85 method, theo nhóm

```
pane.*         29   read send_input send_keys send_text run split move close focus resize swap
                    zoom rename list get current layout edges neighbor process_info
                    report_agent report_agent_session report_metadata release_agent
                    clear_agent_authority wait_for_output graphics.*
workspace.*     8   list get create focus rename move close report_metadata
agent.*         8   list get read send start rename focus explain
tab.*           7   list get create focus rename move close
plugin.*       11   list enable disable link unlink action.list action.invoke pane.* log.list
server.*        5   stop reload_config reload_agent_manifests agent_manifests live_handoff
worktree.*      4   list create open remove
layout.*        3   apply export set_split_ratio
events.*        2   subscribe wait
integration.*   2   install uninstall
client.*        2   window_title.set window_title.clear
session.snapshot · notification.show · popup.close · ping
```

## Event stream — công cụ giám sát fleet thật sự

### Đăng ký

```json
{"id":"sub1","method":"events.subscribe","params":{"subscriptions":[
  {"type":"pane.agent_status_changed","pane_id":"w3:p2"},
  {"type":"pane.agent_status_changed","pane_id":"w4:p1"},
  {"type":"pane.exited"},
  {"type":"pane.agent_detected"}
]}}
```

Server ack `{"id":"sub1","result":{"type":"subscription_started"}}`, sau đó **đẩy event
liên tục trên cùng kết nối**, mỗi event một dòng:

```json
{"event":"pane.agent_status_changed",
 "data":{"pane_id":"w3:p2","workspace_id":"w3","agent_status":"blocked","agent":"fake-1"}}
```

### Loại subscription

**Có tham số bắt buộc:**

| Type | Bắt buộc | Tuỳ chọn |
|---|---|---|
| `pane.agent_status_changed` | `pane_id` | `agent_status` (lọc theo state) |
| `pane.output_matched` | `pane_id`, `source`, `match` | `lines`, `strip_ansi` |
| `pane.scroll_changed` | `pane_id` | — |

**Toàn cục, không cần tham số:**

```
workspace.created  workspace.updated  workspace.metadata_updated  workspace.renamed
workspace.moved  workspace.closed  workspace.focused
tab.created  tab.closed  tab.focused  tab.renamed  tab.moved
pane.created  pane.closed  pane.updated  pane.focused  pane.moved  pane.exited
pane.agent_detected
worktree.created  worktree.opened  worktree.removed
layout.updated
```

> **Hai ràng buộc phải nhớ cùng lúc:**
>
> 1. `pane.agent_status_changed` **bắt buộc `pane_id`** — không có bản toàn cục. Theo dõi cả
>    fleet = liệt kê từng pane trong cùng một mảng `subscriptions`.
> 2. **Mỗi kết nối chỉ subscribe được một lần.** Request thứ hai không ack và làm nghẽn stream.
>
> Cộng lại: pane sinh sau **không thể** thêm vào bằng subscribe bổ sung. Bắt
> `pane.created` / `pane.agent_detected` rồi **đóng kết nối, mở lại với danh sách đầy đủ**,
> sau đó quét `agent list` một lượt để bù khoảng trống.

### `match` cho output

```json
{"type":"substring","value":"All tests passed"}
{"type":"regex","value":"FAIL|Error:"}
```

## `events.wait` — chờ một lần rồi thôi

```json
{"id":"w1","method":"events.wait","params":{
  "match_event":{"event":"pane_agent_status_changed","pane_id":"w3:p2"},
  "timeout_ms":300000}}
```

Đây chính là thứ `herdr wait` gọi bên dưới. Dùng CLI cho tiện, dùng socket khi cần chờ
nhiều điều kiện trên một kết nối.

> Tên event trong `match_event` dùng **gạch dưới** (`pane_agent_status_changed`), còn
> subscription dùng **dấu chấm** (`pane.agent_status_changed`). Không thống nhất — dễ sai.

## Khung Python giám sát fleet

```python
import socket, json, os

s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(os.path.expanduser("~/.config/herdr/herdr.sock"))

def call(method, params, rid="1"):
    s.sendall((json.dumps({"id": rid, "method": method, "params": params}) + "\n").encode())

panes = ["w3:p2", "w4:p1"]
call("events.subscribe", {"subscriptions":
    [{"type": "pane.agent_status_changed", "pane_id": p} for p in panes]
    + [{"type": "pane.exited"}]})

f = s.makefile("r")
print("ack:", f.readline().strip())

for line in f:                                  # stream vô hạn
    ev = json.loads(line)
    d = ev.get("data", {})
    if d.get("agent_status") in ("blocked", "done"):
        print(f"[{d['agent_status']}] {d['pane_id']} — cần xử lý")
        # → đọc pane, quyết định, report-agent ngược lại
```

Ưu điểm so với N tiến trình `herdr wait`: một kết nối, không polling, không đẻ process.

## Ghi trạng thái ngược về panel

```json
{"id":"r1","method":"pane.report_agent","params":{
  "pane_id":"w3:p2","source":"pho","agent":"reviewer",
  "state":"blocked","message":"chờ duyệt migration","seq":42}}
```

- `state` là **ngữ nghĩa** — ảnh hưởng `wait`, notification, rollup lên tab/workspace.
  Chỉ nhận `idle` · `working` · `blocked` · `unknown`. **`done` không báo được** — herdr tự
  suy ra khi tiến trình kết thúc, và bị đè nếu một source khác đang giữ quyền với seq cao hơn.
- `seq` phải **tăng nghiêm ngặt trong mỗi `source`**; seq cũ hoặc bằng bị bỏ qua **im lặng**.
- Nhiều `source` cùng báo một pane thì tranh nhau — bộ nhận diện của herdr cũng là một source.
  Xong việc thì `pane.release_agent` để trả quyền lại.
- `pane.report_metadata` chỉ đổi hiển thị, **không** đụng vòng đời. Có `ttl_ms` để tự hết hạn.
