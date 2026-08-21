#!/usr/bin/env python3
"""
fleet-watch.py — bước 6: theo dõi cả fleet bằng MỘT kết nối socket.

Rẻ hơn hẳn N tiến trình `herdr wait`: không polling, không đẻ process.
Chỉ in ra khi có agent chuyển sang state cần người (`blocked` / `done`) — im lặng khi
mọi thứ đang chạy bình thường.

Hai đặc tính của herdr mà script này phải lách:

1. `pane.agent_status_changed` bắt buộc `pane_id`, không có bản toàn cục → phải liệt kê
   từng pane. Pane sinh sau không tự vào stream.
2. Mỗi kết nối chỉ `events.subscribe` được MỘT lần. Gửi lần hai không ack và làm nghẽn
   stream → khi có pane mới, phải **mở lại kết nối** với danh sách đầy đủ.

Sau mỗi lần kết nối lại, script quét `agent list` một lượt để bù những chuyển trạng thái
rơi vào khoảng trống, và khử trùng lặp bằng state đã in lần trước.

Dùng:
  fleet-watch.py                    # chạy mãi, in khi có agent cần người
  fleet-watch.py --once             # thoát ngay sau sự kiện đầu tiên
  fleet-watch.py --read 20          # kèm 20 dòng output của pane khi có sự kiện
  fleet-watch.py --timeout 600      # tự thoát sau 600 giây không có gì

Exit: 0 có sự kiện / dừng bình thường · 1 hết giờ · 2 server không chạy
"""
import argparse
import json
import os
import socket
import subprocess
import sys

SOCKET_PATH = os.path.expanduser("~/.config/herdr/herdr.sock")
NEEDS_HUMAN = ("blocked", "done")
# event báo có pane mới; herdr trả tên lúc dùng dấu chấm lúc dùng gạch dưới nên đã chuẩn hoá
LIFECYCLE = ("pane_created", "pane_agent_detected")


def agents():
    """[(pane_id, name, state)] của mọi agent đang có."""
    out = subprocess.run(["herdr", "agent", "list"],
                         capture_output=True, text=True).stdout
    return [(a["pane_id"], a["name"], a["agent_status"])
            for a in json.loads(out)["result"]["agents"]]


def read_pane(pane_id, lines):
    return subprocess.run(
        ["herdr", "pane", "read", pane_id, "--source", "visible", "--lines", str(lines)],
        capture_output=True, text=True,
    ).stdout


def connect(panes, timeout):
    """Mở kết nối mới và subscribe một lần cho toàn bộ danh sách pane."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(SOCKET_PATH)
    subs = ([{"type": "pane.agent_status_changed", "pane_id": p} for p in sorted(panes)]
            + [{"type": "pane.created"}, {"type": "pane.agent_detected"}])
    s.sendall((json.dumps({"id": "watch", "method": "events.subscribe",
                           "params": {"subscriptions": subs}}) + "\n").encode())
    f = s.makefile("r")
    ack = json.loads(f.readline())
    if "error" in ack:
        raise RuntimeError(ack["error"])
    if timeout:
        s.settimeout(timeout)
    return s, f


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--once", action="store_true", help="thoát sau sự kiện đầu tiên")
    ap.add_argument("--read", type=int, default=0, metavar="N",
                    help="kèm N dòng output của pane khi có sự kiện")
    ap.add_argument("--timeout", type=float, default=None, metavar="GIÂY",
                    help="tự thoát sau khoảng lặng này")
    args = ap.parse_args()

    if not os.path.exists(SOCKET_PATH):
        print("herdr server không chạy — khởi động: herdr server >/dev/null 2>&1 &",
              file=sys.stderr)
        return 2

    watched = {p for p, _, _ in agents()}
    reported = {}                       # pane_id -> state đã in, để khỏi in lại

    def emit(pane, name, state):
        if reported.get(pane) == state:
            return False
        reported[pane] = state
        print(f"\n[{state}] {pane} {name}".rstrip())
        if args.read:
            for ln in read_pane(pane, args.read).rstrip("\n").split("\n"):
                print("   " + ln)
        sys.stdout.flush()
        return True

    try:
        sock, f = connect(watched, args.timeout)
    except RuntimeError as e:
        print("subscribe lỗi:", e, file=sys.stderr)
        return 2

    print(f"# đang theo dõi {len(watched)} pane — im lặng nghĩa là mọi thứ ổn",
          file=sys.stderr)

    # bắt trạng thái đang có sẵn: `wait` và event chỉ bắn khi CHUYỂN trạng thái,
    # nên agent đã blocked từ trước sẽ không sinh event nào
    for pane, name, state in agents():
        if state in NEEDS_HUMAN and emit(pane, name, state) and args.once:
            return 0

    while True:
        try:
            line = f.readline()
        except socket.timeout:
            print("# hết giờ, không có sự kiện nào", file=sys.stderr)
            return 1
        if not line:
            return 0

        ev = json.loads(line)
        data = ev.get("data", {})
        name = ev.get("event", "").replace(".", "_")

        if name in LIFECYCLE:
            fresh = {p for p, _, _ in agents()} - watched
            if not fresh:
                continue
            watched |= fresh
            print(f"# theo dõi thêm: {', '.join(sorted(fresh))}", file=sys.stderr)
            # mỗi kết nối chỉ subscribe được một lần → mở lại với danh sách đầy đủ
            sock.close()
            sock, f = connect(watched, args.timeout)
            # bù những chuyển trạng thái rơi vào khoảng trống lúc kết nối lại
            for pane, agent_name, state in agents():
                if state in NEEDS_HUMAN and emit(pane, agent_name, state) and args.once:
                    return 0
            continue

        state = data.get("agent_status")
        if state not in NEEDS_HUMAN:
            if state:                      # rời khỏi trạng thái cần người → cho phép in lại sau
                reported.pop(data.get("pane_id", ""), None)
            continue

        if emit(data.get("pane_id", "?"), data.get("agent") or "", state) and args.once:
            return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
