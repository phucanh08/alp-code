#!/usr/bin/env bash
#
# fleet-inbox.sh — bước 2+3: danh sách agent cần người, kèm output đã cắt ngắn.
#
# Chỉ liệt kê pane ở state `blocked` hoặc `done` — agent đang `working` không có gì để đọc.
# Không có --read thì chỉ in danh sách (rẻ); có --read N thì kèm N dòng cuối mỗi pane.
#
# Dùng:
#   fleet-inbox.sh                 # chỉ danh sách
#   fleet-inbox.sh --read 25       # kèm 25 dòng output mỗi pane
#   fleet-inbox.sh --state done    # lọc theo state khác
#
# Exit: 0 không có gì cần xử lý · 1 có · 2 server không chạy / tham số sai
#
set -euo pipefail

export READ_LINES=0
export FILTER="blocked,done"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --read)  READ_LINES="${2:-25}"; shift 2 ;;
    --state) FILTER="${2:-blocked,done}"; shift 2 ;;
    *) echo "tham số lạ: $1 (dùng --read N | --state s1,s2)" >&2; exit 2 ;;
  esac
done

if ! herdr status server 2>/dev/null | grep -q "status: running"; then
  echo "herdr server không chạy — khởi động: herdr server >/dev/null 2>&1 &" >&2
  exit 2
fi

python3 <<'PY'
import json, os, subprocess, sys

want  = set(os.environ["FILTER"].split(","))
lines = int(os.environ["READ_LINES"])

out = subprocess.run(["herdr", "agent", "list"],
                     capture_output=True, text=True).stdout
agents = [a for a in json.loads(out)["result"]["agents"]
          if a["agent_status"] in want]

if not agents:
    print("Không có agent nào ở state:", ",".join(sorted(want)))
    sys.exit(0)

# blocked trước done — cái chờ người khẩn hơn cái chờ nghiệm thu
agents.sort(key=lambda a: (a["agent_status"] != "blocked", a["pane_id"]))

for a in agents:
    print(f'── {a["agent_status"]:<8} {a["pane_id"]:<8} {a["name"]}')
    if lines > 0:
        body = subprocess.run(
            ["herdr", "pane", "read", a["pane_id"],
             "--source", "visible", "--lines", str(lines)],
            capture_output=True, text=True).stdout
        for ln in body.rstrip("\n").split("\n"):
            print("   " + ln)
        print()

sys.exit(1)
PY
