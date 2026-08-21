---
name: herdr
description: "Quản fleet AI agent chạy trong terminal qua herdr — quét trạng thái, đọc agent đang blocked, trả lời, giao việc mới, báo trạng thái ngược về panel. Dùng khi cần theo dõi nhiều agent song song, chạy batch agent, hỏi 'agent nào đang chờ', 'fleet thế nào', hoặc khi thấy lệnh herdr."
metadata:
  author: pho
  version: "1.1.0"
  herdr-verified: "0.8.0"
---

# herdr — quản fleet agent

herdr = tmux cho AI agent. Mỗi agent chạy trong một pane terminal thật; herdr thêm lớp
quan sát + điều phối qua CLI và Unix socket.

**Phân cấp:** `session › workspace › tab › pane › agent`
**ID:** `w3` · `w3:t1` · `w3:p2`. Target agent nhận cả pane id lẫn tên agent.
**State:** `idle · working · blocked · done · unknown` — **cuộn ngược lên** tab rồi workspace.

## Bước 0 — luôn làm trước

```bash
herdr --version            # CLI đổi giữa các minor; hướng dẫn này khớp 0.8.0
herdr status server        # not running → herdr server >/dev/null 2>&1 &
```

Khác phiên bản thì tin `herdr <nhóm> --help` hơn file này. 0.7→0.8 đã xoá cả nhóm `herdr wait`
và đổi hẳn `agent start`.

## Vòng lặp chuẩn

```
1. QUÉT ────── fleet-scan.sh ───────────── rollup, ~45 tok/workspace
2. KHOANH ──── fleet-inbox.sh ──────────── chỉ pane blocked/done
3. ĐỌC ─────── pane read --lines 30 ────── chỉ pane cần
4. QUYẾT ĐỊNH  agent prompt --wait / start ─ hành động
5. BÁO LẠI ─── pane report-agent --seq ─── panel phản ánh đúng thực tế
6. CHỜ ─────── fleet-watch.py ──────────── event stream, không polling
```

**Mỗi bước chỉ mở rộng khi bước trước cho tín hiệu.** Fleet không có gì `blocked` thì dừng
ở bước 1, chi phí gần bằng không.

## Script kèm theo

```bash
scripts/fleet-scan.sh              # bảng workspace + rollup, sắp theo độ khẩn
scripts/fleet-inbox.sh [--read N]  # pane blocked/done; --read N kèm N dòng output mỗi pane
scripts/fleet-watch.py [--once]    # event stream, in ra khi có agent cần người
```

Ưu tiên chạy script thay vì tự viết python inline — rẻ hơn và đã kiểm chứng.

## Sáu lệnh chạy 90% việc

```bash
herdr workspace list                                   # quét, rẻ nhất
herdr agent list                                       # agent ↔ pane ↔ state
herdr pane read <pane> --source visible --lines 30     # LUÔN có --lines
herdr agent prompt <target> "<text>" --wait            # gửi + chờ trạng thái ổn định
herdr agent send-keys <target> Enter                   # trả lời menu / xác nhận
herdr agent wait <target> --until blocked --timeout <ms>
```

Giao việc mới — **hai bước** trong 0.8.0: `agent start` cần một pane **đã ở dấu nhắc shell**.

```bash
P=$(herdr pane split --pane w3:p1 --direction down --cwd ~/AnhlpProjects/api --no-focus \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
herdr agent start rev-auth --kind claude --pane $P --timeout 60000 \
     -- "review module auth, chỉ báo lỗi correctness"
```

`--kind` nhận: `claude` `codex` `gemini` `cursor` `copilot` `devin` `droid` `amp` `grok`
`opencode` `hermes` `kimi` `kiro` `cline` `omp` `pi` `agy` `mastracode` `kilo` `qodercli` `maki`.
`--no-focus` bắt buộc khi spawn hàng loạt, nếu không sẽ cướp màn hình.

**Không cần cài `herdr integration install claude`** — nhận diện bằng screen manifest đã chạy
tốt: tự nhận `agent: claude`, `interactive_ready`, và bắt đúng `blocked` khi Claude hỏi
trust-folder. Cài integration chỉ để nhận state qua hook thay vì đọc màn hình.

Chẩn đoán khi state trông sai:

```bash
herdr agent explain <target>        # rule nào khớp, priority, kèm trích màn hình làm bằng
```

## Luật context

1. **Bắt đầu bằng `workspace list`, không bao giờ bằng `pane read`.** Rollup cho biết chỗ nào
   cần chú ý mà không tốn một dòng output nào.
2. **`pane read` luôn kèm `--lines`.** Không có = nuốt cả buffer.
3. **Không `api snapshot` khi fleet > 3 pane.**
4. **Chỉ đọc pane state ≠ `idle`/`working`.** Agent đang chạy không có gì để đọc.

| Lệnh | Chi phí (đo trên 0.8.0) |
|---|---|
| `workspace list` | ~45 tok / workspace |
| `agent list` | ~60 tok / agent |
| `pane list` | ~78 tok / pane |
| `pane read --lines 30` | ~300 tok |
| `api snapshot` | ~440 tok cho 2 pane, tăng tuyến tính |

## Ba bẫy chết người

1. **`agent wait` chỉ bắt CHANGE.** Chờ `idle` khi đang `idle` → hết giờ (exit 1).
   Luôn `agent list` trước, chỉ `wait` khi state chưa khớp.
   Gửi prompt rồi chờ thì dùng `agent prompt --wait` — nó lo sẵn phần này.
2. **`--seq` phải tăng nghiêm ngặt.** Seq cũ hoặc bằng → **bỏ qua im lặng, exit 0**.
   Giữ `SEQ=$((SEQ+1))` suốt phiên.
3. **Pipe nuốt exit code.** `herdr wait ... | head` → `$?` là của `head`. Bắt exit trước khi pipe.

Thêm hai điều hay sai:

- **`report-agent` không nhận `done`.** `done` là state herdr tự suy ra khi tiến trình kết
  thúc. Giữ quyền bằng seq cao còn **đè mất** `done` — tiến trình chết mà panel vẫn `working`.
  Xong việc thì `herdr pane release-agent <pane> --source pho --agent <label> --seq <n>`.
- **Mỗi kết nối socket chỉ `events.subscribe` được một lần.** Lần hai không ack, nghẽn stream.
  Dùng `fleet-watch.py` thay vì tự viết — nó đã xử lý reconnect khi có pane mới.
- **CLI đổi giữa các minor.** 0.7→0.8 xoá cả nhóm `herdr wait` (→ `agent wait --until`,
  `pane wait-output`), bỏ `agent send` (→ `agent prompt` / `agent send-keys`), và đổi hẳn
  `agent start`. Lệnh báo `unknown option` thì kiểm tra `herdr --version` trước khi debug.

## Phải hỏi Phúc Anh trước khi chạy

- `agent start` — spawn agent thật, tốn token thật
- `agent prompt` / `agent send-keys` / `pane run` / `pane send-text` — gõ vào phiên agent đang
  chạy; nó có thể sửa code hoặc deploy dựa trên câu trả lời đó
- `pane close` / `workspace close` / `server stop` — giết việc đang chạy dở

Lệnh chỉ đọc (`workspace list`, `agent list`, `pane read`, `agent explain`, `status`) và lệnh
chỉ đổi panel (`report-agent`, `report-metadata`) thì tự chạy được.

## Ngưỡng báo cáo

Im lặng là mặc định. Chỉ lên tiếng khi:
- Agent `blocked` bằng câu hỏi Phở không có thẩm quyền trả lời
- Agent `done`, kết quả cần nghiệm thu
- Agent `working` quá lâu bất thường
- ≥ 2 agent `blocked` cùng lúc — dấu hiệu kế hoạch sai từ đầu

Không dán output thô vào báo cáo. Tóm tắt, kèm `pane_id` để Phúc Anh tự `herdr agent attach`.

## Cần sâu hơn thì đọc

Đường dẫn tính từ gốc repo `agent-memory` (`~/AnhlpProjects/agent-memory`):

| Việc | File | Chi phí |
|---|---|---|
| Vòng lặp giám sát đầy đủ | `docs/herdr/fleet-loop.md` | ~2.1k tok |
| Tìm lệnh CLI cụ thể | `docs/herdr/cli-map.md` | ~1.6k tok |
| Event stream, gọi API trực tiếp | `docs/herdr/socket-api.md` | ~1.7k tok |
| Hành vi lạ — 15 bẫy đã kiểm chứng | `docs/herdr/gotchas.md` | ~2.1k tok |
| Công thức batch sẵn | `docs/herdr/recipes.md` | ~1.5k tok |

**Đọc đúng một file cho việc trước mắt.** Nạp cả thư mục = ~9k token, gần như luôn lãng phí.
Cần chi tiết flag của một lệnh thì `herdr <nhóm> --help` rẻ hơn đọc file.
