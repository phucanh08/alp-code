# herdr — Vòng lặp giám sát fleet (L1)

> Cách Phở trông một đàn agent: **quan sát → khoanh vùng → quyết định → báo lại panel → chờ**.
> Đọc file này khi thật sự sắp chạy vòng lặp. Nền tảng ở [`README.md`](README.md).

## Hình dạng vòng lặp

```
┌─ 1. QUAN SÁT ──── workspace list ────────── ~45 tok/ws, không đọc pane nào
│  2. KHOANH VÙNG ─ agent list ───────────── chỉ khi có ws ≠ idle
│  3. ĐỌC ───────── pane read --lines ────── CHỈ pane blocked/done
│  4. QUYẾT ĐỊNH ── agent prompt --wait ──── hành động
│  5. BÁO LẠI ───── report-agent + metadata ─ panel phản ánh đúng thực tế
└─ 6. CHỜ ───────── wait / events.subscribe ─ không polling mù
```

Nguyên tắc xuyên suốt: **mỗi bước chỉ mở rộng khi bước trước cho tín hiệu.** Không có
workspace nào `blocked` thì vòng lặp dừng ở bước 1 với chi phí gần bằng không.

## 1. Quan sát — rollup là bạn

```bash
herdr workspace list
```

```json
{"workspace_id":"w3","label":"api","agent_status":"blocked","pane_count":4,...}
```

`agent_status` ở đây **đã cuộn từ mọi agent bên trong**. Một workspace 8 pane vẫn chỉ tốn
một dòng. Đây là lý do không bao giờ được bắt đầu bằng `pane read`.

Phân loại ngay:

| Rollup | Nghĩa | Làm gì |
|---|---|---|
| `blocked` | có agent đang chờ người | **ưu tiên cao nhất** — vào ngay |
| `done` | có agent xong, chờ nghiệm thu | vào xem kết quả |
| `working` | đang chạy | bỏ qua, quay lại sau |
| `idle` | rảnh | ứng viên nhận việc mới |
| `unknown` | herdr chưa nhận diện được | xem `gotchas.md` |

## 2. Khoanh vùng

Chỉ chạy khi bước 1 có workspace đáng chú ý:

```bash
herdr agent list          # tên, pane_id, workspace_id, agent_status
```

Lọc ra đúng những pane `blocked` / `done`. Đây là danh sách việc của vòng này.

## 3. Đọc — nơi context dễ chết nhất

```bash
herdr pane read w3:p2 --source visible --lines 40
```

`--source`:

| Giá trị | Trả về | Dùng khi |
|---|---|---|
| `visible` | đúng những gì đang trên màn hình | mặc định, xem agent đang hỏi gì |
| `recent` | buffer gần đây, có wrap | cần thêm ngữ cảnh phía trên |
| `recent-unwrapped` | như trên, không bẻ dòng | khi cần parse bằng máy |

Trả về **text thô**, không phải JSON. `--lines` là van context duy nhất — luôn mở nhỏ trước
(20–40), chỉ nới khi thật sự thiếu.

**Không đọc pane `working`.** Nó đang chạy, output sẽ khác đi ngay sau khi bạn đọc.

## 4. Quyết định & hành động

```bash
herdr agent prompt w3:p2 "dùng phương án B, bỏ qua migration" --wait   # gửi + chờ ổn định
herdr agent send-keys w3:p2 Enter                                      # trả lời menu/xác nhận
herdr pane run w3:p2 "npm test"                                        # lệnh shell + Enter
```

`agent prompt --wait` là primitive chính: submit rồi chờ đến khi agent về `idle`/`done`/`blocked`.
Nó đòi thấy một chuyển trạng thái trong 5000ms, không thì trả `agent_prompt_stalled`.
Agent đang hỏi bằng **menu chọn** (kiểu trust-folder của Claude Code) thì dùng `send-keys`,
không dùng `prompt`.

Giao việc mới — **hai bước** ở 0.8.0, `agent start` cần pane đã ở dấu nhắc shell:

```bash
P=$(herdr pane split --pane w3:p1 --direction down --cwd ~/AnhlpProjects/api --no-focus \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
herdr agent start reviewer --kind claude --pane "$P" --timeout 60000 \
  -- "review diff trên branch hiện tại, chỉ báo lỗi correctness"
```

`--no-focus` để không cướp màn hình của Phúc Anh khi spawn hàng loạt.
Thành công nghĩa là herdr đã nhận diện đúng agent trong pane và nó `interactive_ready`.

## 5. Báo lại panel — phần hay bị quên

Panel chỉ hữu ích nếu nó phản ánh đúng thực tế. Sau mỗi quyết định, **ghi trạng thái ngược lại
vào herdr** để lần quét sau rẻ và đúng:

```bash
# state ngữ nghĩa — ảnh hưởng wait, notification, rollup
herdr pane report-agent w3:p2 --source pho --agent reviewer \
     --state working --message "đã trả lời, để nó chạy tiếp" --seq $SEQ

# nhãn hiển thị — chỉ để người đọc, KHÔNG ảnh hưởng vòng đời
herdr pane report-metadata w3:p2 --source pho \
     --title "review#412" --state-label blocked="chờ Phúc Anh duyệt" --seq $SEQ
```

Hai loại tách bạch, đừng nhầm:

| Lệnh | Ảnh hưởng | Dùng cho |
|---|---|---|
| `report-agent` | **có** — wait, rollup, thông báo | trạng thái thật của công việc |
| `report-metadata` | không — chỉ hiển thị | tiêu đề, nhãn, token trang trí |

`--state` chỉ nhận `idle` · `working` · `blocked` · `unknown`. **`done` không báo được** —
herdr tự suy ra khi tiến trình kết thúc. Và khi Phở đang giữ quyền với seq cao, `done` do
herdr phát hiện sẽ bị đè: tiến trình chết mà panel vẫn `working`.

`--seq` **phải tăng nghiêm ngặt cho mỗi `--source`**. Giữ một biến đếm suốt phiên:

```bash
SEQ=$((SEQ+1))
```

Dùng seq cũ → herdr im lặng bỏ qua, **exit vẫn 0**, panel sai mà không ai biết.

Khi Phở thôi quản một pane, trả quyền lại cho bộ nhận diện của herdr:

```bash
herdr pane release-agent w3:p2 --source pho --agent reviewer --seq $((++SEQ))
```

## 6. Chờ — đừng polling mù

**Một pane:**

```bash
herdr agent list | grep w3:p2      # kiểm tra state HIỆN TẠI trước
herdr agent wait w3:p2 --until blocked --timeout 300000
echo "exit=$?"                     # 0 = có event, 1 = hết giờ
```

> `agent wait` **chỉ bắt chuyển trạng thái**. Nếu pane đã ở đúng state bạn chờ, nó sẽ ngồi đến
> hết giờ. Luôn kiểm tra state hiện tại trước — hoặc dùng `agent prompt --wait` cho trường hợp
> vừa gửi vừa chờ.

**Chờ một chuỗi trong output:**

```bash
herdr pane wait-output w3:p2 --match "All tests passed" --lines 5 --timeout 600000
```

Kèm `--lines` — không có nó, kết quả nhúng cả buffer vào JSON trả về.

**Cả fleet cùng lúc** → `scripts/fleet-watch.py` của skill `herdr` (đã xử lý sẵn chuyện
reconnect khi có pane mới). Cơ chế bên dưới: [`socket-api.md`](socket-api.md).
Một kết nối socket theo dõi N pane rẻ hơn N tiến trình `wait`.

## Khung vòng lặp hoàn chỉnh

```bash
SEQ=0
while :; do
  # 1. quét rẻ
  hot=$(herdr workspace list | python3 -c '
import json,sys
for w in json.load(sys.stdin)["result"]["workspaces"]:
    if w["agent_status"] in ("blocked","done"):
        print(w["workspace_id"], w["agent_status"])
')
  [ -z "$hot" ] && { sleep 30; continue; }     # cả fleet ổn → ngủ, không đọc gì

  # 2-5. chỉ đào vào workspace nóng
  herdr agent list | ...                        # lọc pane blocked/done
  herdr pane read "$pane" --source visible --lines 40
  # ...quyết định...
  herdr pane report-agent "$pane" --source pho --agent "$label" \
       --state working --seq $((++SEQ))
done
```

## Ngưỡng báo cáo lên Phúc Anh

Theo `HEARTBEAT.md` — **im lặng là mặc định**. Chỉ lên tiếng khi:

- Một agent `blocked` bằng câu hỏi mà Phở không có thẩm quyền trả lời.
- Một agent `done` với kết quả cần nghiệm thu.
- Một agent `working` quá lâu bất thường so với việc được giao.
- Fleet có ≥ 2 agent `blocked` cùng lúc — dấu hiệu kế hoạch sai từ đầu, không phải sự cố lẻ.

Báo cáo dùng đúng định dạng ở `AGENTS.md` mục 5. Không dán output thô của agent vào báo cáo —
tóm tắt, kèm `pane_id` để Phúc Anh tự `herdr agent attach` nếu muốn xem tận mắt.
