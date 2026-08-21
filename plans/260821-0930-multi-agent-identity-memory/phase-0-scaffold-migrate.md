# P0 — Scaffold + Migrate Phở

**Mục tiêu:** cây thư mục đứng vững, Phở chạy được y như trước ở vị trí mới. Chưa có ACL, chưa có hook.
**Nghiệm thu:** mở `cd identity/main && claude`, Phở boot đúng, đọc được memory, không lỗi path.

## 0.1 Dựng cây

```
agent-memory/
├── README.md
├── CHARTER.md
├── .gitignore                      # identity/*/.claude/settings.json
├── identity/
│   ├── REGISTRY.md
│   ├── _shared/{HOUSE-RULES.md,VOICE.md,PRINCIPAL.md}
│   ├── _template/{CLAUDE.md,IDENTITY.md,SOUL.md,PLAYBOOK.md,RELATIONS.md,loadout.yaml,journal/.gitkeep}
│   └── main/
├── memory/
│   ├── INDEX.md
│   ├── README.md
│   ├── shared/{decisions,people,reference}/
│   ├── projects/{INDEX.md,PROTOCOL.md,_template/}
│   └── private/main/
├── skills/
├── hooks/
└── scripts/
```

`git init` ở P0. `.gitignore`:
```
identity/*/.claude/settings.json
.DS_Store
```

## 0.2 Bảng migrate — file cũ → file mới

Nguồn: `~/AnhlpProjects/agent-team/pho/`

| Cũ | Mới | Ghi chú |
|---|---|---|
| `IDENTITY.md` | `identity/main/IDENTITY.md` | thêm `role: main`; `workspace:` đổi path; bỏ bảng "Bộ file cấu thành Phở" (chuyển vào `_template`) |
| `SOUL.md` | `identity/main/SOUL.md` | **giữ nguyên** phần tính cách/giọng riêng. Cắt phần "Tính liên tục" (đường dẫn) → viết lại theo path mới |
| `AGENTS.md` §1, §2, §5 | `identity/main/PLAYBOOK.md` | vai trò + quy trình phiên + định dạng báo cáo — **riêng vai main** |
| `AGENTS.md` §3, §6, §7 | `identity/_shared/HOUSE-RULES.md` | luật cứng + khi nào hỏi + thứ tự ưu tiên khi xung đột — **dùng chung mọi vai** |
| `AGENTS.md` §4 | `skills/agent-memory/SKILL.md` (P2) | bảng "ghi vào đâu" → thành luật của skill, dùng chung |
| `USER.md` | `identity/_shared/PRINCIPAL.md` | **một bản duy nhất**. Mục "Cách giao tiếp" tách ra `_shared/VOICE.md` |
| `USER.md` → "Cách giao tiếp" | `identity/_shared/VOICE.md` | quy ước output chung |
| `TOOLS.md` §0,§1,§5,§6 | `identity/_shared/HOUSE-RULES.md` (gộp) | luật herdr, chọn tự làm/giao, giao việc, chạy song song |
| `TOOLS.md` §2,§3,§4 | `identity/main/loadout.yaml` + `RELATIONS.md` (P1) | bảng định tuyến → `delegates_to`; quyền công cụ → `tools:` |
| `HEARTBEAT.md` | `identity/main/HEARTBEAT.md` | riêng vai này (chỉ main chạy heartbeat) |
| `BOOTSTRAP.md` | `identity/_template/CLAUDE.md` + hook P2 | trình tự boot thành **hook inject**; CLAUDE.md còn lại là fallback mỏng |
| `MEMORY.md` | `memory/INDEX.md` | mục lục toàn kho, dùng chung |
| `memory/{decisions,people,reference}/` | `memory/shared/…` | **giữ nguyên nội dung**, chỉ đổi vị trí |
| `projects/**` | `memory/projects/**` | giữ nguyên toàn bộ, gồm `PROTOCOL.md`, `_template/`, `INDEX.md` |
| `scripts/sync-project-index.sh` | `scripts/sync-project-index.sh` | sửa `PROJECTS_DIR="$ROOT/memory/projects"` |
| `docs/**`, `skills/herdr/**` | `docs/**`, `skills/herdr/**` | copy nguyên |
| `.claude/session-state/` | **bỏ** | rác phiên cũ |

**Quy tắc cắt AGENTS.md:** câu nào bắt đầu bằng "Phở là…" hoặc mô tả vai main → `PLAYBOOK.md`.
Câu nào là luật an toàn/trung thực áp cho mọi agent → `HOUSE-RULES.md`. Nghi ngờ → `_shared` (DRY thắng).

## 0.3 Sửa đường dẫn

Sau khi copy, chạy và sửa **hết** kết quả:

```bash
cd ~/AnhlpProjects/agent-memory
grep -rn "main/pho\|agent-team/pho\|projects/INDEX\|memory/decisions\|memory/people\|memory/reference" \
  --include="*.md" --include="*.sh" .
```

Ánh xạ: `projects/` → `memory/projects/` · `memory/X/` → `memory/shared/X/` · `MEMORY.md` → `memory/INDEX.md`.

## 0.4 File mới cần viết

**`identity/REGISTRY.md`** — L0 của tầng identity:
```markdown
| Vai | Tên | Emoji | Model | Báo cáo cho | Trạng thái |
|---|---|---|---|---|---|
| main | Phở | 🍜 | claude-opus-5 | principal | ACTIVE |
```

**`CHARTER.md`** — hiến chương: hệ này là gì, ai tồn tại, luật nào áp cho mọi vai, cách thêm vai,
và **ranh giới `shared/` vs `private/`** (chống rủi ro #5).

**`identity/_template/`** — khuôn đầy đủ, mọi chỗ đặc thù thay bằng `{{ROLE}}` `{{NAME}}` `{{EMOJI}}`.

**`memory/README.md`** — kế thừa `pho/memory/README.md`, thêm mục `shared/` vs `private/` vs `projects/`.

## 0.5 Nghiệm thu P0

- [ ] `cd identity/main && claude` → Phở tự nhận diện đúng (qua `CLAUDE.md`, chưa cần hook)
- [ ] `grep -rn "agent-team/pho" .` → **0 kết quả**
- [ ] `scripts/sync-project-index.sh` → chạy được, không lỗi path
- [ ] Hỏi Phở "principal là ai, thích gì" → trả lời đúng từ `_shared/PRINCIPAL.md`
- [ ] Hỏi Phở "project nào đang chạy" → đọc đúng `memory/projects/INDEX.md`
- [ ] `git log` có 1 commit khởi tạo (**chờ principal duyệt mới commit**)
- [ ] `agent-team/pho` **chưa xoá** — giữ nguyên đến khi P3 xong
