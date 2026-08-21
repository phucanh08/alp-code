# P1 — Spike verify + loadout.yaml + compile-acl.sh

**Mục tiêu:** ACL khai báo được ở 1 file, sinh ra `.claude/settings.json`, và **biết chắc** lớp nào enforce thật.
**Phụ thuộc:** P0.

---

## 1.0 Spike bắt buộc — deny × permission mode

**Không viết dòng code nào của P1.1 trước khi spike này xong.** Kết quả đổi kiến trúc P2.

Dựng 2 thư mục giả:
```
/tmp/acl-spike/{alpha,beta}/          # alpha có .claude/settings.json
/tmp/acl-spike/secret/leak.txt        # nội dung: "LEAKED"
```

`alpha/.claude/settings.json`:
```json
{
  "permissions": {
    "additionalDirectories": ["/tmp/acl-spike"],
    "deny": ["Read(/tmp/acl-spike/secret/**)", "Edit(/tmp/acl-spike/secret/**)"]
  }
}
```

Chạy từ `/tmp/acl-spike/alpha`, ghi kết quả từng ô:

| # | Lệnh | Mode | Kỳ vọng | Thực tế |
|---|---|---|---|---|
| 1 | `claude -p "đọc /tmp/acl-spike/secret/leak.txt"` | default | DENY | ? |
| 2 | như trên | `--permission-mode acceptEdits` | DENY | ? |
| 3 | như trên | `--permission-mode bypassPermissions` | **?** | ? |
| 4 | `claude -p "chạy: cat /tmp/acl-spike/secret/leak.txt"` | default | **có thể ALLOW** (deny Read không phủ Bash) | ? |
| 5 | như #4 | bypassPermissions | ALLOW | ? |
| 6 | thêm hook PreToolUse tối giản chặn `secret` → #4 lại | bypassPermissions | DENY | ? |

**Kết luận rẽ nhánh:**

- **#3 = DENY** → settings là lớp chính. P2 viết `acl-guard.cjs` chỉ matcher `Bash` (lớp 2). Effort P2 giữ nguyên.
- **#3 = ALLOW** → settings vô hiệu ở bypass. `acl-guard.cjs` phải phủ `Bash|Read|Edit|Write|Glob|Grep`, **và** ghi vào `CHARTER.md`: *phiên agent cấm chạy `bypassPermissions`*. P2 +0.5 ngày.
- **#6 = ALLOW** → hook không fire ⇒ **kiến trúc ACL sụp**, dừng lại, quay về brainstorm.
  (Ít khả năng: phiên brainstorm này chạy bypass và `scout-block.cjs` vẫn chặn được.)

Ghi kết quả vào `memory/shared/reference/claude-code-acl-behavior.md` — đây là fact đáng nhớ, không phải rác phiên.

---

## 1.1 `loadout.yaml` — schema

Đặt tại `identity/<role>/loadout.yaml`. **Nguồn sự thật duy nhất của ACL.**

```yaml
# --- danh tính (không ảnh hưởng ACL) ---
role: main          # BẮT BUỘC, trùng tên thư mục
name: Phở
emoji: 🍜
model: claude-opus-5

# --- quan hệ ---
reports_to: principal
delegates_to: [researcher]    # vai này được giao việc cho ai

# --- ACL: đường dẫn tương đối tính từ memory/ ---
memory:
  read:  [shared/**, projects/**, private/main/**]
  write: [shared/**, projects/**, private/main/**]

# --- công cụ & skill ---
tools:  [Read, Write, Edit, Glob, Grep, Bash, WebSearch, WebFetch]
skills: [agent-memory, herdr, alp:plan, alp:cook]
```

**Luật validate** (`compile-acl.sh` fail nếu vi phạm):
1. `role` trùng `basename` thư mục.
2. Mọi mục trong `memory.write` phải nằm trong `memory.read`.
3. Không vai nào được `read`/`write` `private/<vai-khác>/**` — cấm cứng, không có ngoại lệ.
4. `private/<role>/**` luôn tự thêm vào cả read và write (không cần khai).
5. `delegates_to`/`reports_to` phải trỏ tới vai có thật hoặc `principal`.

---

## 1.2 `scripts/compile-acl.sh`

```
compile-acl.sh              # = --all (mặc định, vì rủi ro #2)
compile-acl.sh --check      # chỉ so sánh, exit 1 nếu lệch — dùng trong doctor/CI
compile-acl.sh <role>       # 1 vai — CẢNH BÁO: sinh settings thiếu deny vai mới
```

**Mặc định là `--all`.** Lý do: `deny` thắng `allow` ⇒ không viết được "cấm `private/**`,
cho `private/<mình>/**`". Bắt buộc **enumerate từng vai anh em**. Thêm 1 vai ⇒ settings của
mọi vai cũ đều thiếu 1 dòng deny ⇒ rò rỉ. `--all` là mặc định để không ai quên.

### Đầu ra — `identity/<role>/.claude/settings.json`

Path **tuyệt đối** (settings không đảm bảo hỗ trợ `../`). Machine-specific ⇒ gitignore.

```json
{
  "$comment": "GENERATED bởi scripts/compile-acl.sh từ loadout.yaml — KHÔNG SỬA TAY",
  "permissions": {
    "defaultMode": "default",
    "additionalDirectories": [
      "/Users/oaidq/AnhlpProjects/agent-memory/identity/_shared",
      "/Users/oaidq/AnhlpProjects/agent-memory/memory/shared",
      "/Users/oaidq/AnhlpProjects/agent-memory/memory/projects",
      "/Users/oaidq/AnhlpProjects/agent-memory/memory/private/main",
      "/Users/oaidq/AnhlpProjects/agent-memory/skills",
      "/Users/oaidq/AnhlpProjects/agent-memory/docs"
    ],
    "deny": [
      "Read(/…/memory/private/researcher/**)",
      "Edit(/…/memory/private/researcher/**)",
      "Read(/…/identity/researcher/**)",
      "Edit(/…/identity/researcher/**)",
      "Edit(/…/identity/_shared/**)",
      "Edit(/…/identity/REGISTRY.md)",
      "Edit(/…/CHARTER.md)",
      "Edit(/…/identity/main/loadout.yaml)",
      "Edit(/…/identity/main/.claude/**)",
      "Edit(/…/scripts/**)",
      "Edit(/…/hooks/**)"
    ]
  }
}
```

**Giải thích từng nhóm deny:**

| Nhóm | Chống | Rủi ro |
|---|---|---|
| `private/<anh-em>/**` | đọc kho riêng vai khác | cách ly |
| `identity/<anh-em>/**` | đọc/sửa persona vai khác | cách ly |
| `identity/_shared/**`, `REGISTRY.md`, `CHARTER.md` | agent tự sửa luật chung | #1 |
| `<mình>/loadout.yaml`, `<mình>/.claude/**` | **self-escalation** | **#1 — P0** |
| `scripts/**`, `hooks/**` | sửa chính công cụ enforce | #1 |

**Không** đưa `memory/private` (thư mục cha) vào `additionalDirectories` — chỉ đưa `private/<role>`.
Deny liệt kê anh em là lớp thứ hai, phòng khi user-level settings có allow rộng.

**Ghi chú `_shared`:** agent **đọc** được, **không sửa** được. Sửa `_shared` là việc của principal.

### Chống drift

Sau khi ghi, in `loadout.yaml` mtime vào `$comment` hoặc file `.acl-stamp`.
`doctor.sh` (P2) so `loadout.yaml` mtime > `settings.json` mtime → báo **ACL-DRIFT** —
cùng cơ chế `modified` mà Project Layer đang dùng.

### Ngôn ngữ

Bash + `yq`. Nếu không có `yq` → Node (`hooks/` đã là `.cjs`, không thêm dependency mới).
Chọn Node nếu spike cho thấy phải viết hook nặng — dùng chung parser YAML.

---

## 1.3 Nghiệm thu P1

- [x] Spike 1.0 xong, 6 ô có kết quả thật, ghi vào `memory/shared/reference/claude-code-acl-behavior.md`
- [x] `compile-acl.sh` sinh `settings.json` hợp lệ cho `main`
- [x] `compile-acl.sh --check` exit 1 khi sửa tay `loadout.yaml` mà chưa recompile
- [x] Validate bắt đúng lỗi: `role` lệch thư mục · `write` ⊄ `read` · khai `private/<vai-khác>`
- [x] Tạo vai giả `identity/qa/` → chạy `compile-acl.sh` → `settings.json` của `main`
      **tự có thêm** dòng deny `private/qa/**`. Xoá vai giả sau khi xong.
- [x] `.gitignore` chặn `identity/*/.claude/settings.json`; `loadout.yaml` **được** track

### Kết quả verify lại — 2026-08-21

- `scripts/compile-acl.sh --check`: OK cho mọi vai.
- Ba ca validate âm đều bị bắt đúng: role lệch, write không nằm trong read, private vai khác.
- Phép thử enumerate bằng vai tạm `qa` được thay bằng phép thử tương đương trên vai thật
  `researcher`: settings của `main` chứa deny tương ứng, và test hồi quy kiểm trực tiếp
  deny của mọi cặp vai. Không để lại fixture `qa` trong cây identity.
- Thu hẹp `additionalDirectories`: chỉ mở `memory/shared`, `memory/projects` và
  `memory/private/<role>`, không mở thư mục cha `memory/`.
- `scripts/test-isolation.sh`: 20/20; `scripts/doctor.sh`: sạch.
