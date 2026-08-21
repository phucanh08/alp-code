# herdr — Bản đồ CLI (L1)

> Chỉ tên lệnh + một dòng. Cần chi tiết flag: `herdr <nhóm> --help` (rẻ hơn đọc file dài).
> Lấy từ `herdr --help` trên **0.8.0**, protocol 19.
>
> ⚠️ **CLI đổi giữa các minor.** 0.7→0.8 xoá cả nhóm `herdr wait`, bỏ `agent send`, đổi hẳn
> `agent start`. Gặp `unknown option` thì kiểm tra `herdr --version` trước khi debug.
> Dòng tóm tắt trong `herdr agent --help` cũng có lúc lệch với `herdr agent start --help` —
> tin cái sau.

## Nhóm lệnh

| Nhóm | Việc |
|---|---|
| `workspace` | container cấp cao — một repo / một nhiệm vụ |
| `tab` | layout trong workspace |
| `pane` | terminal thật — đọc, ghi, tách, đóng |
| `agent` | tiến trình herdr nhận diện được trong pane |
| `worktree` | git worktree helper |
| `session` | namespace runtime, detach/reattach |
| `integration` | tích hợp nhận diện agent dựng sẵn |
| `notification` | thông báo hệ thống |
| `api` | metadata + snapshot của socket API |
| `config` / `channel` / `server` | vận hành server |

## workspace

```
workspace list                                    liệt kê + agent_status đã cuộn
workspace create [--cwd PATH] [--label TEXT]      tạo mới
workspace focus|rename|close <id>
workspace report-metadata                         nhãn hiển thị cấp workspace
```

## tab

```
tab list|get|create|focus|rename|move|close
tab create [--workspace ID] [--cwd PATH]
```

## pane — nhóm lớn nhất (29 method)

**Đọc**
```
pane list [--workspace ID]        pane get <id>        pane current
pane read <id> --source visible|recent|recent-unwrapped [--lines N] [--format text|ansi]
pane process-info | layout | edges | neighbor --direction <d>
```

**Ghi**
```
pane send-text <id> <text>        text thuần, không Enter
pane run <id> <command>           lệnh + Enter
pane send-keys <id> <key>...      phím riêng lẻ
pane wait-output <id> (--match TEXT | --regex PATTERN) [--source <s>] [--lines N]
                      [--timeout MS] [--raw]
```

> `pane wait-output` là chỗ ở mới của `herdr wait output` (nhóm `wait` đã bị xoá ở 0.8.0).

**Bố cục**
```
pane split <id> --direction right|down [--ratio F] [--cwd PATH] [--no-focus]
pane move <id> --tab <tab_id>|--new-tab|--new-workspace
pane focus|resize|swap|zoom|rename|close
```

**Báo trạng thái ngược về panel**
```
pane report-agent <id> --source ID --agent LABEL --state idle|working|blocked|unknown
                       [--message TEXT] [--seq N]
pane report-metadata <id> --source ID [--title TEXT] [--state-label ST=TEXT] [--seq N] [--ttl-ms N]
pane release-agent <id> --source ID --agent LABEL [--seq N]
pane report-agent-session <id> ...        gắn session id/path của agent
```

## agent

```
agent list                                  agent get <target>
agent read <target> --source visible|recent|recent-unwrapped|detection [--lines N]
agent prompt <target> <text> [--wait] [--until STATUS]... [--timeout MS]
agent send-keys <target> <key> [key ...]    phím — trả lời menu, xác nhận
agent wait <target> [--until STATUS]... [--timeout MS]
agent start <name> --kind KIND --pane ID [--timeout MS] [-- <agent-args...>]
agent rename|focus|attach <target>
agent explain <target> [--json|--format text|json] [--verbose]
```

**Target** nhận: tên agent duy nhất · pane id đang chứa agent.

### `agent start` — hai bước, không phải một

Pane phải **đã ở dấu nhắc shell** trước. Không có `--cwd` / `--workspace` / `--split` nữa:

```bash
P=$(herdr pane split --pane w3:p1 --direction down --cwd ~/api --no-focus \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
herdr agent start rev-auth --kind claude --pane "$P" --timeout 60000 -- "review module auth"
```

`--kind`: `pi` `claude` `codex` `gemini` `cursor` `devin` `agy` `cline` `omp` `mastracode`
`opencode` `copilot` `kimi` `kiro` `droid` `amp` `grok` `hermes` `kilo` `qodercli` `maki`

Thành công nghĩa là herdr **đã nhận diện được** đúng agent đó trong pane và nó sẵn sàng nhận
input (`interactive_ready: true`).

### `agent prompt --wait` — primitive của vòng lặp batch

Gửi prompt rồi chờ trạng thái ổn định trong một lệnh:

- Xuất phát từ state không phải `working`: `--wait` đòi thấy **một chuyển trạng thái trong
  5000ms**, không thì trả `agent_prompt_stalled`. `--timeout` ngắn hơn thì trả `timeout`.
- Mặc định khớp `idle` / `done` / `blocked`; `--until` để chỉ định chính xác.
- **Không theo dõi lượt (turn).** Agent đang `working` sẵn thì lượt đang chạy đó có thể khớp.

### `agent explain` — chẩn đoán state

Chạy tốt với agent herdr **tự nhận diện**. In ra rule nào khớp, priority, region, kèm trích
màn hình làm bằng chứng:

```
agent: claude
state: blocked
rule: live_blocked_form (region=after_last_horizontal_rule priority=980)
evidence: " Quick safety check: Is this a project you created or one you trust? ..."
```

Agent do Phở tự khai bằng `report-agent` → lỗi `agent_explain_unavailable`, bình thường.

### `agent wait`

Không có `--until` thì khớp `idle` / `done` / `blocked`. Exit **0** = trúng, **1** = hết giờ
(kèm JSON `{"error":{"code":"timeout"}}`). **Chỉ bắt chuyển trạng thái**, không bắt state đang có.

## Vận hành

```
herdr status [server|client]      herdr server stop        herdr server reload-config
herdr api snapshot                toàn bộ cây — đắt, tránh khi fleet lớn
herdr api schema [--json]         schema socket API (~235KB, ĐỪNG đọc thẳng — grep/parse)
herdr integration install <name> | integration status [--outdated-only]
```

## Định dạng output

Hầu hết lệnh trả **một dòng JSON** ra stdout:

```json
{"id":"cli:pane:list","result":{"type":"pane_list","panes":[...]}}
{"id":"cli:agent:explain","error":{"code":"...","message":"..."}}
```

Ngoại lệ: `pane read` / `agent read` trả **text thô**.

Parse bằng `python3 -c` cho gọn:

```bash
herdr agent list | python3 -c '
import json,sys
for a in json.load(sys.stdin)["result"]["agents"]:
    print(a["pane_id"], a["name"], a["agent_status"])'
```
