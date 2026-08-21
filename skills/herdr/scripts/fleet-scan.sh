#!/usr/bin/env bash
#
# fleet-scan.sh — bước 1 của vòng lặp: quét fleet bằng rollup, rẻ nhất có thể.
#
# In một dòng mỗi workspace, sắp theo độ khẩn (blocked → done → working → idle).
# Chi phí không đổi theo số pane bên trong, vì `workspace list` đã cuộn sẵn trạng thái.
#
# Dùng:
#   fleet-scan.sh           # bảng người đọc
#   fleet-scan.sh --json    # JSON thô, cho script khác dùng tiếp
#
# Exit: 0 fleet yên · 1 có workspace blocked/done cần xử lý · 2 server không chạy
#
set -euo pipefail

SERVER_STATUS="$(herdr status server 2>/dev/null || true)"
if [[ "$SERVER_STATUS" != *"status: running"* ]]; then
  echo "herdr server không chạy — khởi động: herdr server >/dev/null 2>&1 &" >&2
  exit 2
fi

MODE="${1:-table}" python3 <<'PY'
import json, os, subprocess, sys

out = subprocess.run(["herdr", "workspace", "list"],
                     capture_output=True, text=True).stdout
data = json.loads(out)["result"]["workspaces"]

if os.environ.get("MODE") == "--json":
    print(json.dumps(data, ensure_ascii=False))
    sys.exit(0)

# thứ tự khẩn cấp: cần người trước, đang chạy sau
URGENCY = {"blocked": 0, "done": 1, "working": 2, "idle": 3, "unknown": 4}
MARK    = {"blocked": "!!", "done": "->", "working": "..", "idle": "  ", "unknown": "??"}

rows = sorted(data, key=lambda w: (URGENCY.get(w["agent_status"], 9), w["workspace_id"]))
hot  = [w for w in rows if w["agent_status"] in ("blocked", "done")]

print(f'{"":2} {"WS":<5} {"NHÃN":<18} {"STATE":<8} PANE')
for w in rows:
    st = w["agent_status"]
    label = (w.get("label") or "")[:18]
    print(f'{MARK.get(st, "  "):2} {w["workspace_id"]:<5} {label:<18} {st:<8} {w["pane_count"]}')

if hot:
    print(f'\n{len(hot)} workspace cần xử lý → chạy fleet-inbox.sh')

sys.exit(1 if hot else 0)
PY
