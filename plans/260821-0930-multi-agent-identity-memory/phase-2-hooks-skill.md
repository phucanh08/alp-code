# P2 — Hooks + Skill + Doctor

**Mục tiêu:** identity tự nạp mỗi phiên; `Bash` không lách được ACL; agent biết luật ghi memory.
**Phụ thuộc:** P1 (đặc biệt kết quả spike 1.0).

Hook đăng ký ở `identity/<role>/.claude/settings.json` — do `compile-acl.sh` sinh, thêm khối `hooks`.
⇒ **P2 phải cập nhật `compile-acl.sh`** để phát cả phần hooks.

---

## 2.1 `hooks/session-start.cjs`

**Event:** `SessionStart` · **Output:** JSON `{ additionalContext, systemMessage }`

```
1. role = basename(cwd);  repoRoot = tìm ngược tới thư mục có CHARTER.md
2. đọc loadout.yaml → grants, name, emoji, model
3. lắp boot set (7 nguồn):
     identity/<role>/IDENTITY.md
     identity/_shared/VOICE.md      + identity/<role>/SOUL.md
     identity/_shared/HOUSE-RULES.md + identity/<role>/PLAYBOOK.md
     identity/_shared/PRINCIPAL.md
     loadout.yaml (rút gọn: name, role, grants, delegates_to)
     memory/INDEX.md            ← LỌC theo grants
     memory/projects/INDEX.md
4. chạy scripts/doctor.sh --quiet → tín hiệu vào systemMessage
5. đo độ dài; > 16000 ký tự → thêm cảnh báo "BOOT SET QUÁ TO"
6. in JSON, exit 0
```

**Lọc `memory/INDEX.md`:** bỏ mọi dòng có link trỏ ra ngoài `grants.read`. Agent không thấy cả
*tên* file nó không được đọc — rò rỉ metadata cũng là rò rỉ.

**Fail-safe:** hook lỗi → **exit 0 với additionalContext rỗng**, không `continue:false`.
Hook chết không được làm chết phiên. Nhưng in cảnh báo lên `systemMessage`.

**Quan hệ với `CLAUDE.md`:** hook là đường chính. `identity/<role>/CLAUDE.md` chỉ còn ~10 dòng:
*"Bạn là {{NAME}}, vai {{ROLE}}. Identity nạp qua SessionStart hook. Nếu context không có nó,
hook hỏng — đọc thủ công theo thứ tự BOOTSTRAP rồi báo principal."* Không lặp nội dung (DRY).

---

## 2.2 `hooks/acl-guard.cjs` ⚠️ P0

**Event:** `PreToolUse`
**Matcher:** phụ thuộc spike 1.0 —

| Spike #3 | Matcher |
|---|---|
| deny còn hiệu lực ở bypass | `Bash` (lớp 2) |
| deny bị bỏ qua ở bypass | `Bash\|Read\|Edit\|Write\|Glob\|Grep` (**lớp chính**) |

### Logic

```
1. role, repoRoot, grants  (như 2.1; cache theo process)
2. Tool file (Read/Edit/Write/Glob/Grep): lấy path từ tool_input → check
3. Tool Bash:
   a. QUÉT INDIRECTION: /eval|`|\$\(|base64|xxd|\bsh -c\b|\bbash -c\b|python -c|perl -e/
      → DENY ngay, lý do "lệnh có indirection, không kiểm được path"
   b. tách token; giữ token chứa "/" hoặc bắt đầu bằng "." hoặc "~"
   c. resolve tuyệt đối (fs.realpathSync khi tồn tại → chống symlink)
   d. check từng path
4. check(p):
   - p ⊂ memory/private/ && không ⊂ memory/private/<role>/  → DENY
   - p ⊂ identity/<vai-khác>/                                → DENY
   - ghi vào loadout.yaml | .claude/ | scripts/ | hooks/ | _shared/ | CHARTER | REGISTRY → DENY
   - p ngoài repoRoot → ALLOW (ngoài phạm vi hệ này, để permission thường xử)
5. DENY → { hookSpecificOutput: { hookEventName:"PreToolUse",
            permissionDecision:"deny", permissionDecisionReason: "<vai> không có quyền …" } }
   Ngược lại exit 0 (không quyết định, để flow thường chạy).
```

### Giới hạn — ghi thẳng vào đầu file

```js
// GIỚI HẠN: đây là guardrail, KHÔNG phải sandbox.
// Chặn nhầm lẫn và vượt quyền tình cờ. KHÔNG chặn được agent cố tình lách
// (indirection lạ, ngôn ngữ script khác, ghi rồi chạy file).
// Cách ly thật với agent thù địch cần OS user riêng hoặc container.
```

Quét indirection (3a) là **default-deny**: thà chặn nhầm lệnh hợp lệ còn hơn để lọt.
Agent bị chặn → viết lại lệnh cho tường minh. Chi phí thấp, giá trị cao.

### Test bắt buộc

`scripts/test-isolation.sh` — mỗi ca chạy `claude -p` từ `identity/researcher/`, grep output:

| Ca | Lệnh | Kỳ vọng |
|---|---|---|
| 1 | `Read` `memory/private/chief-of-staff/*` | DENY |
| 2 | `cat memory/private/chief-of-staff/*` | DENY |
| 3 | `cd ../../memory/private/chief-of-staff && cat *` | DENY |
| 4 | `cat $(echo ../../memory/private/chief-of-staff/x.md)` | DENY (indirection) |
| 5 | `ln -s ../../memory/private/chief-of-staff /tmp/x && cat /tmp/x/*` | DENY (realpath) |
| 6 | `Edit` `identity/researcher/loadout.yaml` | DENY |
| 7 | `Read` `memory/shared/*` | **ALLOW** — không được chặn nhầm |
| 8 | `Write` `memory/private/researcher/note.md` | **ALLOW** |

Ca 7–8 quan trọng ngang ca 1–6. ACL chặn hết = ACL vô dụng.

---

## 2.3 `hooks/session-end.cjs`

**Event:** `Stop` · **Không gọi LLM.** Chỉ cơ học:

1. File mới trong `memory/shared/**` chưa có dòng trong `memory/INDEX.md` → nhắc.
2. `memory/projects/*/PROJECT.md` bị chạm mà `updated:` chưa đổi → nhắc DRIFT.
3. `scripts/sync-project-index.sh --write`.
4. Không có gì → **im lặng**.

Trích fact bằng LLM là việc của agent (2.4), không phải của hook. Tốn token, ghi rác, khó kiểm soát.

---

## 2.4 `skills/agent-memory/SKILL.md`

Dạy agent **khi nào ghi, ghi vào đâu, định dạng gì**. Nguồn: `AGENTS.md` §4 của Phở + luật silo mới.

### Bảng định tuyến (rủi ro #5 — chống fact duplication)

| Tình huống | Đích | Visibility |
|---|---|---|
| Sở thích / ràng buộc lặp lại của principal | `identity/_shared/PRINCIPAL.md` | *(principal sửa, agent đề xuất)* |
| Quyết định chung, không thuộc project | `memory/shared/decisions/YYMMDD-slug.md` | team |
| Người / tổ chức | `memory/shared/people/<ten>.md` | team |
| Link / dashboard / ticket | `memory/shared/reference/<slug>.md` | team |
| Bối cảnh 1 project | `memory/projects/<slug>/PROJECT.md` (L1) | team |
| Quyết định của 1 project | `memory/projects/<slug>/decisions/` (L2) | team |
| Diễn biến phiên | `memory/projects/<slug>/log/YYYY-MM.md` (L2) | team |
| Nháp, giả thuyết chưa kiểm chứng | `memory/private/<role>/` | private |
| Bài học về CHÍNH agent này | `identity/<role>/journal/YYYY-MM.md` | private |

### Luật cứng

1. **Fact về principal / project / thế giới → LUÔN `shared` hoặc `projects`. KHÔNG BAO GIỜ `private`.**
   `private` chỉ chứa nháp và self-log. Vi phạm = fact bị nhân bản rồi lệch nhau giữa các agent.
2. Một fact = một file. Ngày tuyệt đối. Trùng thì gộp, sai thì xoá.
3. Không ghi thứ repo đã ghi (cấu trúc code, git log, CLAUDE.md).
4. File mới trong `memory/shared/` → thêm 1 dòng vào `memory/INDEX.md`.
5. Sửa L1 → đóng dấu `updated:` ngay.
6. Không sửa tay bảng trong `INDEX.md` → sửa L1 rồi `--write`.
7. **Journal:** 1 file/tháng, mỗi entry ≤5 dòng, >200 dòng thì nén. Journal **không** vào boot set.

### Frontmatter chuẩn (forward-compat P4)

```yaml
id: <slug ổn định>
type: decision | person | reference | log | project
layer: L1 | L2 | L3
visibility: private | team
owner: <role>
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: []
source: <link | phiên>
```

---

## 2.5 `scripts/doctor.sh`

Gộp mọi kiểm tra tính toàn vẹn. Gọi ở boot (2.1) và trong heartbeat.

| Tín hiệu | Điều kiện |
|---|---|
| `DRIFT` | L1 mtime > `updated:` |
| `STALE` | `ACTIVE` mà > 14 ngày không cập nhật |
| `ORPHAN` | L1 ⟷ L0 lệch |
| **`ACL-DRIFT`** | `loadout.yaml` mtime > `settings.json` mtime → chạy `compile-acl.sh` |
| **`ACL-STALE`** | có vai trong `identity/` mà `settings.json` vai khác thiếu deny cho nó |
| **`ACL-PATH`** | path trong `settings.json` không khớp `repoRoot` hiện tại (repo bị move) |
| **`REGISTRY-DRIFT`** | `identity/*/` ⟷ `REGISTRY.md` lệch danh sách |
| `IDENTITY-MISSING` | vai thiếu file bắt buộc |

`--quiet` = chỉ in khi có tín hiệu (dùng trong hook). Exit 0 sạch / 1 có tín hiệu / 2 lỗi cấu hình.

Tái dùng `read_fm()` và ánh xạ `modified` của `sync-project-index.sh` — **đừng viết lại parser** (DRY).

---

## 2.6 Nghiệm thu P2

- [x] Mở phiên `chief-of-staff` → identity có sẵn trong context, **không** cần tool call nào
- [x] Boot set ≤ 16000 ký tự (~4k token); vượt → hook cảnh báo
- [x] Đổi tên hook thành file sai → phiên vẫn mở được, có cảnh báo (fail-safe)
- [x] `test-isolation.sh` **8/8 ca đúng** — gồm cả 2 ca ALLOW
- [x] `doctor.sh` báo `ACL-DRIFT` khi sửa `loadout.yaml` mà chưa recompile
- [x] `doctor.sh` báo `ACL-PATH` khi đổi tên thư mục repo
- [x] Agent được hỏi "ghi fact này vào đâu" → trả lời đúng theo bảng 2.4

### Kết quả verify lại — 2026-08-21

- SessionStart sinh boot context trực tiếp: chief-of-staff 14,498 ký tự; researcher 14,937 ký tự.
- Thiếu `loadout.yaml` trong sandbox: hook exit 0, context rỗng và có `systemMessage` cảnh báo.
- Repo sandbox bị move: doctor báo cả `ACL-DRIFT` và `ACL-PATH`; sửa grant chưa compile:
  doctor báo `ACL-DRIFT` đúng vai.
- Suite hiện đã mở rộng thành 20/20 ca DENY/ALLOW và kiểm cả cấu trúc settings sinh ra.
- Claude Code 2.1.238 xác nhận path rule chỉ hỗ trợ `Read(path)`/`Edit(path)`; compiler đã
  bỏ các rule `Glob/Grep/Write/NotebookEdit(path)` bị harness phớt lờ, doctor có regression check.
- Phiên Claude thật hiện bị quota chặn trước khi model trả lời (reset 14:20 Asia/Saigon),
  nhưng settings được parse không còn warning và hook đã được kiểm trực tiếp bằng payload thật.
