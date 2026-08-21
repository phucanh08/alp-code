---
type: brainstorm
date: 2026-08-21
topic: Delegation tự động — Phở tự giao việc qua herdr
status: agreed
depends_on: brainstorm-260821-1602-alp-init-default-pho.md
---

# Brainstorm — Delegation tự động

## 1. Nguyên nhân gốc (đo được, không phải phỏng đoán)

Pain: "không biết khi nào gọi vai phụ, phải gõ `run-role.sh` tay".
Chẩn đoán: **không phải Phở thiếu thông minh — hạ tầng chặn nó.**

| # | Lỗi | Bằng chứng |
|---|---|---|
| 1 | `RELATIONS.md` KHÔNG trong boot set của Phở | `hooks/session-start.cjs:97-105` nạp IDENTITY·VOICE·SOUL·HOUSE-RULES·PLAYBOOK·PRINCIPAL·INDEX·L0 — thiếu RELATIONS |
| 2 | Vai phụ LẠI được nạp RELATIONS | `run-role.cjs:79` |
| 3 | `run-role.cjs` chỉ chạy tương tác | `spawnSync("codex", …, {stdio:"inherit"})` — TUI, không phải `codex exec` |

⇒ Bảng định tuyến "giao cho ai, khi nào" (2KB) nằm ngoài context của **đúng vai cần nó**.
Và về mặt cơ khí Phở **không** tự delegate được kể cả khi muốn.

## 2. Phương án chốt

### 2.1 Trigger — vá boot set
Thêm `RELATIONS.md` vào boot set. +2KB, ngân sách 15K vẫn thừa. Sửa 1 dòng, giải quyết ~80%.

### 2.2 Cơ chế — herdr là chính, `codex exec` là fallback

| Hình dạng việc | Đường chạy |
|---|---|
| ≥2 vai song song · >1 phút · cần theo dõi/tương tác · review nhiều concern | **herdr pane** |
| Một câu hỏi · đồng bộ · <1 phút · **hoặc không có fleet (headless)** | **`run-role.cjs --exec`** (`codex exec`) |

Luật cứng, không để model tự cân — bất nhất giữa các phiên là thứ khó debug nhất.

### 2.3 Danh tính — Codex profile, tách khỏi workspace

`alp init` (brainstorm #1) sinh `~/.codex/<role>.config.toml` cho cả 7 vai **từ `loadout.yaml`**:
model · `model_reasoning_effort` · `sandbox=read-only` · `approval=never` · hooks · `--search` cho librarian.

```bash
P=$(herdr pane split --pane w3:p1 --direction down --cwd <project> --no-focus | jq -r .result.pane.pane_id)
herdr agent start search-auth --kind codex --pane $P -- -p search -C <project> "<task>"
```

**Đã kiểm chứng:** `herdr agent start` có `[-- [AGENT_ARG]...]` pass-through (herdr 0.8.0)
⇒ truyền được `-p <role> -C <project>`. Đây là rủi ro lớn nhất của phương án và nó đã được gỡ.

Hệ quả DRY: logic boot đang tồn tại 3 chỗ (hook · `run-role.buildBoot()` · sẽ là herdr)
→ còn **1** (profile + hook). Xoá được `buildBoot()`.

### 2.4 Tự chủ & phanh

- Phở **tự quyết**, báo một dòng trước khi chạy: `→ giao Search: tìm call-site auth`
- **Miễn xin phép** cho 7 vai trong `delegates_to`. Spawn ngoài danh sách hoặc `--kind` lạ → vẫn hỏi.
  ⇒ phải sửa `skills/herdr/SKILL.md` mục "Phải hỏi Phúc Anh trước khi chạy" cho khớp.
- Trần **3–4 phiên đồng thời** (đã có trong `_shared/DELEGATION.md`), hết trần thì Phở tự làm.
- Cuối lượt liệt kê đã gọi vai nào — principal thấy quota đi đâu.
- Vai phụ **không được** spawn tiếp: deny Bash `herdr`/`run-role` trong loadout vai phụ. Chống đệ quy.

## 3. Việc phải làm

1. `hooks/session-start.cjs` — thêm `RELATIONS.md` vào boot set
2. `alp init` — sinh `~/.codex/<role>.config.toml` cho 7 vai từ loadout
3. `run-role.cjs` — thêm `--exec` (`codex exec`), bỏ `buildBoot()`, giữ `wrapDelegatedPrompt`
4. `skills/herdr/SKILL.md` — miễn xin phép cho `delegates_to`
5. `_shared/DELEGATION.md` — thêm mục "cách chạy": bảng chọn herdr vs exec + snippet
6. `identity/main/loadout.yaml` — allowlist Bash cho herdr read-only + `run-role --exec` (khỏi hỏi permission mỗi lần)
7. `identity/<sub-role>/loadout.yaml` — deny herdr/run-role

## 4. Rủi ro

| Rủi ro | Xử lý |
|---|---|
| `release-agent` quên gọi → panel kẹt `working`, `done` bị đè | wrapper luôn release; `alp doctor` phát hiện pane mồ côi |
| `--seq` phải tăng nghiêm ngặt, seq cũ bị **bỏ qua im lặng** | seq counter trong wrapper, không để model tự đếm |
| herdr CLI đổi giữa minor (0.7→0.8 xoá cả nhóm `wait`) | wrapper pin `herdr --version`; doctor báo lệch |
| Oracle chạy `--kind claude` → profile Codex không áp dụng | truyền `-- --settings <path>` (đã test `--settings` nạp hook OK) |
| Phở lạm dụng: câu hỏi tầm thường sinh 5 phiên | trần 3–4 + báo chi phí + luật "một câu hỏi → exec, không phải pane" |
| `codex exec` chưa chắc tôn trọng `-p profile` | phải test trước khi code |

## 5. Đo lường

- Phở tự delegate không cần principal gõ lệnh: **0 → 100%**
- logic boot: **3 chỗ → 1**
- boot set: +2KB, vẫn < 15K ngân sách
- `test-communication.cjs` + `test-delegation.cjs` vẫn xanh sau đổi cơ chế

## 6. Kết quả test giả định (đã chạy thật, 2026-08-21)

**Cả hai giả định ĐÚNG.** Không phải quay lại phương án dự phòng.

### T1 — `codex exec -p <profile>` (codex v0.149.0)
```
model: definitely-not-a-real-model-xyz     ← từ profile
approval: never                            ← từ profile
sandbox: read-only                         ← từ profile
reasoning effort: low                      ← từ profile
```
**TOÀN BỘ loadout nhét vừa vào profile.** `run-role.cjs` rút gọn còn
`codex exec -p <role> -C <project>` — không flag nào khác. `buildBoot()` xoá được hoàn toàn.

### T2 — `herdr agent start --kind claude -- <args>` (herdr 0.8.0)
```
argv: ["claude", "--settings", "<path>"]   ← pass-through nguyên vẹn
marker: PASSTHROUGH-OK                     ← hook SessionStart đã chạy
```

### Ba phát hiện phụ — phải đưa vào implementation

| # | Phát hiện | Hệ quả |
|---|---|---|
| 1 | `codex exec` **đọc stdin mặc định** → treo vô hạn khi không có TTY | wrapper BẮT BUỘC `< /dev/null`. Đây là lý do lệnh test đầu treo 120s. |
| 2 | sandbox mặc định của `exec` là **`workspace-write`**, không phải read-only | `sandbox_mode = "read-only"` phải nằm trong profile, không dựa vào mặc định |
| 3 | **Dialog trust chặn hook.** Pane mới ở cwd chưa trust → Claude hỏi "Is this a project you trust?", hook KHÔNG chạy cho tới khi trả lời | `alp init` phải trust cả hai runtime: `~/.claude.json` **và** `[projects."<path>"] trust_level="trusted"` trong `~/.codex/config.toml`. Không trust = delegation chết câm. |

Phát hiện 3 chính là `TRUST-MISSING` mà `doctor.sh` đã cảnh báo — giờ nó áp cả cho pane herdr.

## 7. Câu hỏi còn treo

- Có nên để Phở tự `release-agent` hay để hook `Stop` dọn → chốt lúc plan
- `alp` là symlink Node hay shell shim (ảnh hưởng Windows) → chốt lúc plan
