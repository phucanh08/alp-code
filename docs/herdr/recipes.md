# herdr — Công thức batch (L2)

> Mẫu sẵn cho các tình huống hay gặp. Copy, sửa, chạy. Khớp herdr **0.8.0**.
> Mọi công thức đều theo luật context ở [`README.md`](README.md).

## 1. Quét fleet — rẻ nhất có thể

```bash
herdr workspace list | python3 -c '
import json,sys
ws=json.load(sys.stdin)["result"]["workspaces"]
order={"blocked":0,"done":1,"working":2,"idle":3,"unknown":4}
for w in sorted(ws,key=lambda w:order.get(w["agent_status"],9)):
    print(f"{w[\"agent_status\"]:<8} {w[\"workspace_id\"]:<5} {w.get(\"label\",\"\"):<16} {w[\"pane_count\"]} pane")'
```

Chi phí không đổi theo số pane. Dùng làm bước 1 của mọi vòng lặp.

## 2. Danh sách việc — chỉ pane cần người

```bash
herdr agent list | python3 -c '
import json,sys
for a in json.load(sys.stdin)["result"]["agents"]:
    if a["agent_status"] in ("blocked","done"):
        print(a["pane_id"], a["name"], a["agent_status"])'
```

## 3. Spawn một batch agent song song

```bash
WS=$(herdr workspace create --cwd ~/AnhlpProjects/api --label review \
     | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["workspace"]["workspace_id"])')

ROOT=$(herdr pane list --workspace "$WS" \
       | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["panes"][0]["pane_id"])')

for target in auth billing search; do
  # 0.8.0: agent start cần một pane ĐÃ ở dấu nhắc shell
  P=$(herdr pane split --pane "$ROOT" --direction down --cwd ~/AnhlpProjects/api --no-focus \
      | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
  herdr agent start "rev-$target" --kind claude --pane "$P" --timeout 60000 \
       -- "review module $target, chỉ báo lỗi correctness, không refactor"
done

herdr workspace list | grep "$WS"      # rollup cho biết cả batch đang thế nào
```

`--no-focus` bắt buộc khi spawn hàng loạt — nếu không, mỗi lần spawn sẽ cướp màn hình.

## 4. Thu hoạch kết quả cả batch mà không tràn context

```bash
herdr agent list | python3 -c '
import json,sys
print("\n".join(a["pane_id"] for a in json.load(sys.stdin)["result"]["agents"]
                if a["agent_status"]=="done"))' | while read -r p; do
  echo "───── $p ─────"
  herdr pane read "$p" --source visible --lines 25
done
```

25 dòng/agent × 6 agent ≈ 1.5k token. Đọc không giới hạn có thể gấp 20 lần con số đó.
Thiếu thì nới `--lines` cho **đúng pane cần**, không nới cho cả vòng lặp.

## 5. Gác một agent cho tới khi cần người

```bash
P=w3:p2
cur=$(herdr agent list | python3 -c "
import json,sys
print(next(a['agent_status'] for a in json.load(sys.stdin)['result']['agents']
           if a['pane_id']=='$P'))")

if [ "$cur" != "blocked" ]; then
  herdr agent wait "$P" --until blocked --timeout 1800000 >/tmp/ev.json 2>&1
  rc=$?
  [ $rc -ne 0 ] && { echo "hết giờ, agent vẫn chạy"; exit 0; }
fi
herdr pane read "$P" --source visible --lines 30      # chỉ đọc khi thật sự blocked
```

Kiểm tra state hiện tại trước — nếu không, `wait` sẽ ngồi hết 30 phút (bẫy #1).

## 6. Chạy test rồi chờ kết quả

```bash
herdr pane run w3:p3 "npm test"
herdr pane wait-output w3:p3 --regex "Tests:.*(passed|failed)" --lines 5 --timeout 600000 \
  > /tmp/t.json 2>&1
rc=$?
[ $rc -eq 0 ] && python3 -c '
import json;print(json.load(open("/tmp/t.json"))["result"]["matched_line"])' \
             || echo "test quá 10 phút chưa xong"
```

`--lines 5` giữ JSON trả về nhỏ; không có nó, cả buffer bị nhúng vào.

## 7. Trả lời một agent đang blocked

```bash
herdr pane read w3:p2 --source visible --lines 20        # nó hỏi gì?

# hỏi bằng câu chữ → prompt (tự chờ trạng thái ổn định)
herdr agent prompt w3:p2 "dùng phương án B" --wait --timeout 300000

# hỏi bằng menu chọn (trust-folder của Claude Code…) → phím, không phải prompt
herdr agent send-keys w3:p2 Enter
```

## 8. Giám sát cả fleet bằng một kết nối socket

```python
#!/usr/bin/env python3
"""Theo dõi mọi agent, chỉ in ra khi có agent cần người."""
import socket, json, os, subprocess

s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(os.path.expanduser("~/.config/herdr/herdr.sock"))
send = lambda m, p, i="1": s.sendall((json.dumps({"id": i, "method": m, "params": p})+"\n").encode())

panes = [a["pane_id"] for a in json.loads(
    subprocess.run(["herdr","agent","list"], capture_output=True, text=True).stdout
)["result"]["agents"]]

send("events.subscribe", {"subscriptions":
    [{"type": "pane.agent_status_changed", "pane_id": p} for p in panes]
    + [{"type": "pane.created"}, {"type": "pane.exited"}]})

f = s.makefile("r"); f.readline()                  # ack

for line in f:
    ev = json.loads(line); d = ev.get("data", {})
    st = d.get("agent_status")
    if st in ("blocked", "done"):
        out = subprocess.run(
            ["herdr","pane","read",d["pane_id"],"--source","visible","--lines","20"],
            capture_output=True, text=True).stdout
        print(f"\n[{st}] {d['pane_id']} {d.get('agent','')}\n{out}")
```

Rẻ hơn N tiến trình `herdr wait`: một kết nối, không polling, không đẻ process.
Nhớ bắt `pane.created` để đăng ký thêm cho pane sinh sau (bẫy #9).

## 9. Cách ly bằng git worktree

```bash
herdr worktree create --help          # xem flag của bản đang cài
herdr worktree list
```

Cho batch agent cùng sửa một repo: mỗi agent một worktree → không giẫm chân nhau, khớp với
luật "một agent = một tập file" ở `AGENTS.md` mục 3.

## 10. Dọn sau khi xong

```bash
herdr pane close w3:p2                 # đóng một pane
herdr workspace close w3               # đóng cả workspace
herdr server stop                      # tắt server headless
```

Trả quyền trước khi đóng nếu Phở đang giữ:

```bash
herdr pane release-agent w3:p2 --source pho --agent rev-auth --seq $((++SEQ))
```
