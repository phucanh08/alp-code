# herdr — L0

> Tầng luôn nạp khi phiên có dùng herdr. **~800 token.** Đừng đọc file nào khác trừ khi bảng
> định tuyến ở cuối bảo đọc.
> Đã kiểm chứng trên herdr **0.8.0**, protocol 19, macOS — gồm cả một agent `claude` thật.
> ⚠️ CLI đổi giữa các minor: gặp `unknown option` thì xem `herdr --version` trước khi debug.

herdr = tmux cho AI agent. Mỗi agent chạy trong một pane terminal thật; herdr thêm một lớp
quan sát + điều phối lên trên, điều khiển qua CLI và Unix socket.

**Phân cấp:** `session › workspace › tab › pane › agent`
**ID:** `w3` (workspace) · `w3:t1` (tab) · `w3:p2` (pane). Target agent nhận cả pane id lẫn tên agent.
**Trạng thái:** `idle · working · blocked · done · unknown` — **cuộn ngược lên** tab rồi workspace.

## Sáu lệnh chạy 90% việc

```bash
herdr workspace list                      # quét fleet — trạng thái đã cuộn lên, RẺ NHẤT
herdr agent list                          # agent nào ở pane nào, state gì
herdr pane read <pane> --source visible --lines 40   # đọc output, LUÔN có --lines
herdr agent prompt <target> "<text>" --wait   # gửi chỉ thị + chờ trạng thái ổn định
herdr agent send-keys <target> Enter      # trả lời menu / xác nhận
herdr pane report-agent <pane> --source pho --agent <label> --state <s> --seq <n>
herdr agent wait <target> --until <s> --timeout <ms>
```

## Luật context — bắt buộc

1. **Bắt đầu bằng `workspace list`, không bao giờ bằng `pane read`.** Rollup cho biết
   workspace nào cần chú ý mà không tốn một dòng output nào của agent.
2. **`pane read` luôn kèm `--lines`.** Không có nó = nuốt cả buffer, không giới hạn.
3. **Không dùng `api snapshot` khi fleet > 3 pane.** Nó dump toàn bộ cây.
4. **Chỉ đọc pane có state ≠ `idle`.** Agent đang `working` không có gì để đọc.

### Giá context đã đo (herdr 0.8.0)

| Lệnh | Chi phí | Tầng |
|---|---|---|
| `workspace list` | ~45 tok / workspace | L0 — quét |
| `agent list` | ~60 tok / agent | L1 — khoanh vùng |
| `pane list` | ~78 tok / pane | L1 — khi cần id |
| `pane read --lines 40` | ~400 tok | L2 — đọc thật |
| `api snapshot` | ~440 tok cho 2 pane, tăng tuyến tính | tránh |

## Ba bẫy chết người

1. **`agent wait` chỉ bắt CHANGE, không bắt state hiện tại.** Chờ `idle` khi đang
   `idle` → hết giờ. Luôn `agent list` trước; vừa gửi vừa chờ thì dùng `agent prompt --wait`.
2. **`--seq` phải tăng nghiêm ngặt.** Gửi lại seq cũ hoặc bằng → **im lặng bỏ qua, exit 0**.
3. **Timeout trả exit 1**, nhưng nếu bạn pipe qua `head` thì `$?` là của `head`. Bắt exit code
   trước khi pipe.

## Cần gì đọc gì

| Việc | Đọc thêm |
|---|---|
| Chạy vòng lặp giám sát fleet: quan sát → quyết định → báo lại panel | [`fleet-loop.md`](fleet-loop.md) |
| Tìm lệnh CLI cụ thể | [`cli-map.md`](cli-map.md) |
| Cần event stream, hoặc gọi API không qua CLI | [`socket-api.md`](socket-api.md) |
| Gặp lỗi lạ, hành vi không như mong đợi | [`gotchas.md`](gotchas.md) |
| Cần công thức sẵn cho một tình huống batch | [`recipes.md`](recipes.md) |

Mỗi file là một lần đọc độc lập. Đọc đúng một file cho việc trước mắt, không đọc gộp.
