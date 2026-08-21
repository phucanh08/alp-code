# P0 — Quick wins

> ~1h · không phụ thuộc gì · **giải quyết ~80% pain delegation**. Ship riêng được.
>
> **Trạng thái: XONG (2026-08-21).** Kết quả đo thật ở mục "Đã làm gì" cuối file —
> có hai chỗ tiền đề của plan sai, đọc trước khi làm P1.

## Bối cảnh

`hooks/session-start.cjs:97-105` nạp 8 nguồn: IDENTITY · VOICE · SOUL · HOUSE-RULES ·
PLAYBOOK · PRINCIPAL · MEMORY INDEX · PROJECTS L0. **Thiếu `RELATIONS.md`** — chính là
bảng định tuyến "giao cho ai, khi nào".

Trớ trêu: `run-role.cjs:79` **có** nạp RELATIONS cho vai phụ. Vai phụ biết bảng, Phở thì không.

## Việc

### 0.1 `RELATIONS.md` vào boot set

`hooks/session-start.cjs` — thêm sau `PLAYBOOK`:

```js
push("RELATIONS", read(path.join(roleDir, "RELATIONS.md"), warnings));
```

Đặt **sau PLAYBOOK, trước PRINCIPAL**: "làm việc thế nào" → "giao cho ai" → "phục vụ ai".

`identity/main/RELATIONS.md` = 2093 bytes. Boot set hiện tại phải đo lại, ngân sách 15000.

### 0.2 Mở `main` cho Codex

`scripts/lib/codex-role.cjs` — thêm `"main"` vào `ALLOWED_ROLES`.

README đang nói "Main có thể chạy Claude Code hoặc Codex" nhưng `isAllowedRole("main")`
trả `false` ⇒ không có launcher nào. Vá đúng chỗ nói dối.

**Lưu ý:** Claude vẫn là runtime **chính** của main (Codex không nạp được `alp:plan`/`alp:cook`).
Codex chỉ là đường phụ tiết kiệm quota.

## Kiểm chứng

```bash
node -e 'require("./scripts/lib/codex-role.cjs").isAllowedRole("main")'   # true
cd identity/main && node ../../hooks/session-start.cjs | python3 -c 'import json,sys; c=json.load(sys.stdin)["hookSpecificOutput"]["additionalContext"]; print(len(c), "RELATIONS" in c)'
```

Phải in: độ dài **< 15000** và `True`.

Nếu vượt ngân sách: hook sẽ **cảnh báo chứ không cắt** (`session-start.cjs:35`). Vượt thì
rút gọn SOUL/PLAYBOOK — **không** bỏ RELATIONS.

```bash
node scripts/test-agent-routing.cjs
node scripts/test-communication.cjs
```

## Định nghĩa hoàn thành

- [x] Phở boot lên thấy được bảng định tuyến 7 vai mà không cần đọc file bằng tool
- [x] boot set trong ngân sách — **ngân sách sửa 15000 → 18000**, xem bên dưới
- [x] `isAllowedRole("main") === true`
- [x] test routing + communication xanh (cả 6 test file)

---

## Đã làm gì — và hai chỗ plan đoán sai

### Sai 1: "boot set hiện tại phải đo lại, ngân sách 15000"

Đo ra: boot set của main **đã 16686 ký tự TRƯỚC khi thêm RELATIONS** — ngưỡng 15000 chưa
bao giờ đạt, nó là ước lượng trên giấy. Thêm RELATIONS lên 18504.

Xử lý (principal chốt): **nâng `BOOT_BUDGET` lên 18000**, không cắt SOUL/HOUSE-RULES/PLAYBOOK.
Lý do: giữ một ngưỡng luôn đỏ thì cảnh báo thành tiếng ồn, không ai đọc nữa. Trước khi nâng
đã cắt hết phần **không đụng nội dung danh tính**:

| Cắt | Trước | Sau |
|---|---|---|
| doctor gộp 8 dòng `TRUST-MISSING` lặp thành 1 | 1233 | 338 |
| bỏ con trỏ "đi đọc `RELATIONS.md`" ở HOUSE-RULES §3 + PLAYBOOK §1 | — | −57 |

Con trỏ đó nay mâu thuẫn với chính boot header ("đừng đọc lại các file này bằng tool").

Kết quả: **17556 / 18000**, boot sạch, không cảnh báo. Dư 444 — mỏng. Muốn về mục tiêu
~4k token của CHARTER §2.6 thì phải rút gọn văn HOUSE-RULES (3891) / SOUL (2634) /
PLAYBOOK (2285). Chưa làm, principal chưa duyệt sửa file persona.

### Sai 2: "thêm `main` vào `ALLOWED_ROLES`" là một dòng

Một dòng đó mở `run-role.cjs` cho main, mà file này bake sẵn ba giả định chỉ đúng với vai phụ:

| Giả định | Vỡ thế nào với main | Đã sửa |
|---|---|---|
| `-m loadout.model` | main khai `model: claude-opus-5` → đưa cho `codex -m` là hỏng câm | thêm `codex_model: gpt-5.6-sol`; launcher lấy `codex_model \|\| model` |
| `wrapDelegatedPrompt` mọi vai | nói với main rằng nó nhận việc từ main và không được nói với principal | main không bọc |
| `-s read-only` cứng | main-on-Codex không ghi nổi `memory/` → vô dụng | `workspace-write` **chỉ** ở repo nhà hoặc `workspaces.write`; ngoài ra read-only |

Cạm bẫy thứ ba là chỗ dễ vỡ **im lặng** — không lỗi, không cảnh báo, chỉ mất bất biến CHARTER.
`test-agent-routing.cjs` nay khoá nó: `main --project /tmp` phải ra `read-only`. Đã mutation-test
(phá logic → test đỏ), không phải test cảnh.

### Ăn theo

`doctor.cjs` kiểm AGENTS.md theo `model` — main khai model Claude nên lọt lưới dù chạy Codex.
Nay xét `codex_model || model`.

### File đã đụng

`hooks/session-start.cjs` · `scripts/lib/codex-role.cjs` · `scripts/run-role.cjs` ·
`scripts/doctor.cjs` · `identity/main/loadout.yaml` · `identity/main/PLAYBOOK.md` ·
`identity/_shared/HOUSE-RULES.md` · `scripts/test-agent-routing.cjs` · `scripts/test-codex-role.cjs`

### Còn nợ cho P1

- `codex_model` chưa có trong `L.validate()` — khai sai chính tả sẽ im lặng rơi về `model`.
- P1 xoá `buildBoot()`; nhớ mang theo nhánh "main không báo cáo cho chính nó".
- P1 đặt `sandbox_mode` trong profile — dùng lại `isInside()`, đừng viết lại luật write.
