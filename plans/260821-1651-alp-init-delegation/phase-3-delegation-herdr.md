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

- [x] Phở tự delegate, principal không gõ lệnh nào
- [x] Không fleet → tự rơi về `--exec`, không lỗi
- [x] Vai phụ bị chặn khi thử spawn
- [x] Xong việc thì `release-agent` được gọi, panel không kẹt `working`
- [x] Cuối lượt có dòng liệt kê vai đã gọi

---

## Đã làm gì — và bốn chỗ plan chưa lường

**Xong 2026-08-21.** Nghiệm thu bằng một pane thật: Titling nhận việc qua herdr, hook boot
chạy, model `gpt-5.6-luna low` đúng từ profile, trả về title, `--release` dọn sạch panel.

### Bề mặt khác plan: `run-role --pane`, không phải lệnh mới

Plan mô tả `herdr-fleet.cjs` như module để model gọi. Nhưng model gọi qua **Bash**, nên nó
cần một CLI — và đã có sẵn một cái đúng chỗ: `run-role`. Thêm `--pane` vào đó giữ được
**một** launcher (`--exec` / `--pane` / tương tác là ba chế độ của cùng một lệnh), và
allowlist chống đệ quy chỉ phải liệt kê hai bin thay vì ba. `--release <pane>` cũng nằm ở
đây vì cùng lý do: seq phải ở trong code.

### Bốn bẫy chỉ lộ ra khi chạy thật

| # | Đo được | Xử lý |
|---|---|---|
| 1 | **herdr từ chối arg có xuống dòng** — `invalid_agent_argument`. Mà prompt delegation LUÔN nhiều dòng | ghi ra `$TMPDIR/alp-delegation/`, thay bằng một dòng trỏ tới file |
| 2 | Dòng trỏ file **mất nguồn ủy nhiệm** ⇒ Titling từ chối: *"chỉ nhận nhiệm vụ từ Phở"* | `delegation.cjs:delegatedPromptPointer` — contract nén một dòng |
| 3 | `foreground_process_group_id == shell_pid` là điều kiện **cần, chưa đủ** (shell đang source `.zshrc` cũng thoả) ⇒ vẫn `agent_pane_busy` | chờ hai lớp: poll process-info **rồi thử lại chính `agent start`** |
| 4 | Phiên Codex tương tác **chặn ở dialog "Hooks need review"** — plan chỉ lường nhánh headless | `--pane` cũng kèm `--dangerously-bypass-hook-trust`; phiên do principal mở thì không |

Thêm hai điều nhỏ: `release-agent`/`report-agent` in ra **rỗng** khi thành công (parse JSON
là ném lỗi trên đúng đường thành công), và `agent start --timeout` phải `> 3000ms`.

### 3.5 làm khác plan: suy từ `delegates_to`, không thêm khoá mới

Plan định khai allow/deny trong từng `loadout.yaml`. Nhưng "vai này có được giao việc
không" đã có sẵn ở `delegates_to` — thêm khoá thứ hai là tạo chỗ cho hai nguồn lệch nhau.
`canDelegate(loadout)` suy ra, `claude-settings` sinh allow (main) / deny (vai phụ).

Và **deny trong settings không đủ**: luật `Bash(...)` khớp theo tiền tố chuỗi, không resolve
lệnh — đúng bài học P2. Lớp enforce thật là `acl-guard`
(`loadout.cjs:checkDelegationCommand`), khớp theo **tên lệnh ở vị trí đầu**, có bóc tiền tố
`VAR=x` và wrapper `node …`. Cố ý không khớp chuỗi con: `grep herdr docs/` vẫn phải chạy được.

### Nợ lại

`--seq` dùng `Date.now()` thay vì counter có state. Đơn điệu qua nhiều tiến trình, không
cần file — nhưng đồng hồ lùi (NTP) thì seq lùi theo. Chưa gặp; nếu gặp, panel sẽ bỏ qua
một lần báo state, không mất dữ liệu.
