# P3 — Delegation qua herdr

> ~0.5 ngày · phụ thuộc P2 (cần profile 7 vai + trust)

## Luật định tuyến — cứng, không để model tự cân

| Hình dạng việc | Đường |
|---|---|
| ≥2 vai song song · >1 phút · cần theo dõi/tương tác · review nhiều concern | **herdr pane** |
| Một câu hỏi · đồng bộ · <1 phút · **hoặc không có fleet (headless)** | **`run-role --exec`** |

Không có luật rõ ⇒ model chọn bất nhất giữa các phiên ⇒ khó debug nhất khi hỏng.

## Việc

### 3.1 `scripts/lib/herdr-fleet.cjs` (module mới)

```bash
P=$(herdr pane split --pane <anchor> --direction down --cwd <project> --no-focus | …pane_id)
# chờ pane tới dấu nhắc shell — agent start lỗi `agent_pane_busy` nếu vội (đã dính khi test)
herdr agent start <label> --kind codex --pane $P --timeout 60000 -- -p <role> -C <project> "<prompt>"
```

**Pass-through đã kiểm chứng** (herdr 0.8.0): `agent start` có `[-- [AGENT_ARG]...]`,
kết quả `argv:["claude","--settings","<path>"]`.

Module lo 4 thứ model hay làm sai:
1. **chờ shell prompt** trước `agent start` (retry, không `sleep` mù)
2. **seq counter** — `--seq` phải tăng nghiêm ngặt; seq cũ/bằng bị **bỏ qua im lặng, exit 0**
3. **`release-agent` luôn được gọi** — `report-agent` không nhận `done`; giữ seq cao sẽ **đè mất**
   `done`, tiến trình chết mà panel vẫn `working`
4. **fallback**: `herdr status server` không running → rơi về `run-role --exec`

Oracle chạy Claude: `--kind claude -- --settings <path>` (đã test, hook chạy).

### 3.2 `_shared/DELEGATION.md` — thêm mục "cách chạy"

Bảng định tuyến trên + 2 snippet. **Không** nằm trong boot set (giữ nguyên thiết kế cũ) —
nạp khi sắp giao việc.

### 3.3 `skills/herdr/SKILL.md` — miễn xin phép

Mục "Phải hỏi Phúc Anh trước khi chạy" đang liệt kê `agent start` ⇒ mâu thuẫn trực tiếp với
"tự quyết, báo một dòng". Sửa thành:

- **Miễn hỏi:** spawn 7 vai trong `delegates_to` của main
- **Vẫn hỏi:** `--kind` ngoài danh sách · agent tự do · `pane close`/`workspace close`/`server stop`

### 3.4 Phanh — `identity/main/PLAYBOOK.md`

- báo **một dòng** trước khi chạy: `→ giao Search: tìm call-site auth`
- trần **3–4 phiên đồng thời** (đã có ở `_shared/DELEGATION.md`), hết trần thì Phở tự làm
- cuối lượt liệt kê đã gọi vai nào — principal thấy quota đi đâu

### 3.5 Chống đệ quy — quan trọng

- `identity/main/loadout.yaml`: allowlist `Bash(herdr *)` + `Bash(node */run-role.cjs *)`
  ⇒ khỏi hỏi permission mỗi lần
- `identity/<sub-role>/loadout.yaml`: **deny** `herdr` + `run-role`

Không có 3.5 thì Search spawn được Search — vòng lặp đốt quota không phanh.

### 3.6 Test

- `test-delegation.cjs`: mở rộng — luật định tuyến chọn đúng đường theo hình dạng việc
- `test-isolation.cjs`: thêm ca "vai phụ gọi `herdr agent start` → bị chặn"
- Manual: Phở nhận "tìm luồng auth trong project X" → tự chọn Search, báo một dòng, trả kết quả

## Định nghĩa hoàn thành

- [ ] Phở tự delegate, principal không gõ lệnh nào
- [ ] Không fleet → tự rơi về `--exec`, không lỗi
- [ ] Vai phụ bị chặn khi thử spawn
- [ ] Xong việc thì `release-agent` được gọi, panel không kẹt `working`
- [ ] Cuối lượt có dòng liệt kê vai đã gọi
