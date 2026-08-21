---
type: brainstorm
date: 2026-08-21
slug: multi-agent-identity-memory
status: agreed
---

# Agent Memory — Identity độc lập + Multi-agent + ACL enforce thật

## 1. Vấn đề

Hiện có: `agent-team/pho` — 1 agent (Phở, main), identity + memory + projects trộn ở root.
Bộ file đó tốt (SOUL/AGENTS tách, progressive disclosure L0→L2, kiểm soát bằng `modified`), nhưng **không nhân bản được cho N agent**.

Cần: hệ multi-agent, identity là thư mục độc lập, mỗi agent có kho memory riêng + phần chung, tham chiếu TencentDB-Agent-Memory.

**Constraint đã chốt:**
- Phase 1 = markdown + skill. Phase 2 (clone Tencent đầy đủ) tính sau.
- Identity chứa: persona + capability/loadout + relationships + self-log.
- Sharing = **silo + ACL rõ ràng**.
- Write trigger = **hook tự động + agent chủ động**.
- Runtime = **mỗi agent 1 phiên Claude Code, CWD riêng**.
- Migrate Phở vào hệ mới.
- **Key theo vai trò**, không theo tên: `identity/main/` ← `name: Phở`.
- Project layer → memory namespace dùng chung.

## 2. Đánh giá TencentDB-Agent-Memory

Kiến trúc: MemoryCore / MemoryKnowledge / MemoryPanel / MemoryProxy, Docker, SQLite+sqlite-vec, 8GB RAM, 2 bộ LLM API key, panel :8125.
4 asset: Chat Memory · Skill · LLM-Wiki · Code-Graph. Pipeline L0 Conversation → L1 Atom → L2 Scenario → L3 Persona. Retrieval: bootstrap L2/L3, fallback BM25+vector+RRF xuống L1/L0. ACL 4 tầng: private / team / restricted / agent-targeted.

**Ăn cắp:** phân tầng L0-L3 · tách asset theo loại · binding "agent nào được đọc gì" · giới hạn retrieval (count/char budget/timeout).
**Bỏ:** Docker multi-service · vector DB · web panel · auto-extract bằng LLM · proxy protocol.

### Ánh xạ Tencent → hệ này (Phase 1)

| Tencent | Ở đây |
|---|---|
| L0 Conversation | **không lưu** — Claude Code đã có transcript ở `~/.claude/projects/` |
| L1 Atom | `memory/shared/**` — 1 fact = 1 file |
| L2 Scenario | `memory/projects/<slug>/` (kế thừa Project Layer của Phở) |
| L3 Persona | `identity/<role>/` — **người viết**, không auto-derive |
| Skill asset | `skills/` — canonical store trung lập runtime (Phở đã có) |
| LLM-Wiki | `docs/` + `memory/shared/reference/` |
| Code-Graph | **bỏ** — dùng skill `alp:gkg` khi cần |
| ACL / visibility | `loadout.yaml` → `.claude/settings.json` (**enforce thật**) |
| Memory Hub panel | **bỏ** — git + grep + `doctor.sh` |
| Retrieval budget | luật trong SKILL.md + boot set ≤7 file |

**Khác biệt cốt lõi:** Tencent auto-derive persona từ chat. Ở đây persona là **hiến pháp do người viết**, pipeline không được ghi đè. Đúng hơn cho use case cá nhân — persona auto-derive trôi dạt sau vài chục phiên.

## 3. Phát hiện then chốt — ACL ép được bằng harness

Đã verify docs Claude Code:

| Cơ chế | Tác dụng |
|---|---|
| `permissions.additionalDirectories` | cấp quyền ra ngoài project root theo danh sách trắng |
| `permissions.deny` | chặn cứng `Read()/Edit()/Glob()` theo glob; **deny thắng allow, merge across scopes** → agent không tự gỡ |
| `PreToolUse` hook → `permissionDecision:"deny"` | chặn `Bash(cat …)` lách luật |
| `SessionStart` hook → `additionalContext` | bơm identity + memory index vào đầu phiên |

⇒ ACL **không phải convention**. `loadout.yaml` → `compile-acl.sh` → `.claude/settings.json` → harness enforce.
Điều này **chỉ đúng với 1 agent = 1 phiên = 1 CWD**. Subagent in-process kế thừa permission của phiên cha ⇒ không cách ly được. Đó là lý do chọn phương án phiên riêng.

## 4. Kiến trúc chốt

```
agent-memory/
├── README.md
├── CHARTER.md                    # hiến chương team: ai tồn tại, luật cứng chung
├── identity/                     # ← THƯ MỤC ĐỘC LẬP
│   ├── REGISTRY.md               # L0: bảng role | name | model | reports_to | status
│   ├── _shared/
│   │   ├── HOUSE-RULES.md        # luật cứng chung (rút từ AGENTS.md của Phở)
│   │   ├── VOICE.md              # quy ước output chung (tiếng Việt, ngắn, không xu nịnh)
│   │   └── PRINCIPAL.md          # USER.md — MỘT bản duy nhất, mọi vai đọc
│   ├── _template/                # khuôn tạo vai mới
│   ├── main/           # name: Phở 🍜
│   │   ├── CLAUDE.md             # entry — Claude Code tự nạp khi cd vào đây
│   │   ├── IDENTITY.md           # name, emoji, role, một câu định nghĩa
│   │   ├── SOUL.md               # tính cách, giọng, ranh giới — riêng vai này
│   │   ├── PLAYBOOK.md           # quy trình riêng của vai
│   │   ├── RELATIONS.md          # delegate cho ai, nhận việc từ ai
│   │   ├── loadout.yaml          # model, tools, skills, memory grants ← NGUỒN ACL
│   │   ├── journal/YYYY-MM.md    # self-log
│   │   └── .claude/settings.json # GENERATED — không sửa tay
│   └── researcher/               # name: Long 🔎
├── memory/
│   ├── INDEX.md                  # L0 mục lục toàn kho
│   ├── shared/{decisions,people,reference}/     # visibility: team
│   ├── projects/                 # L2 — Project Layer, dùng chung
│   │   ├── INDEX.md  PROTOCOL.md  _template/
│   │   └── <slug>/{PROJECT.md,decisions/,log/,refs/}
│   └── private/<role>/           # SILO — chỉ chủ nhân đọc/ghi
├── skills/agent-memory/SKILL.md  # dạy agent đọc/ghi memory đúng luật
├── hooks/{session-start.cjs,acl-guard.cjs,session-end.cjs}
└── scripts/{new-role.sh,compile-acl.sh,sync-index.sh,doctor.sh}
```

### loadout.yaml — nguồn sự thật của ACL

```yaml
role: researcher
name: Long
emoji: 🔎
model: claude-opus-5
reports_to: main
delegates_to: []
memory:
  read:  [shared/**, projects/**, private/researcher/**]
  write: [projects/*/refs/**, private/researcher/**]
skills: [alp:research, alp:docs-seeker, agent-memory]
```

### Boot set (luôn nạp, ≤7 file — kế thừa Phở)

```
1 IDENTITY.md   2 _shared/VOICE.md + SOUL.md   3 _shared/HOUSE-RULES.md + PLAYBOOK.md
4 _shared/PRINCIPAL.md   5 loadout.yaml   6 memory/INDEX.md (đã lọc theo grant)
7 memory/projects/INDEX.md
```
Không nạp cả `memory/`, không nạp cả `projects/`. L1/L2 mở theo yêu cầu.

### Hooks — mechanical, không gọi LLM

| Hook | Việc |
|---|---|
| `session-start.cjs` | resolve role từ CWD → `additionalContext` = boot set đã lọc theo grant; chạy `doctor.sh` → DRIFT/STALE/ORPHAN vào `systemMessage` |
| `acl-guard.cjs` (PreToolUse, matcher `Bash`) | parse path trong lệnh; ngoài grant → `permissionDecision:"deny"` |
| `session-end.cjs` (Stop) | file memory mới chưa có dòng trong `INDEX.md` → nhắc; `sync-index.sh --write` |

**Hook KHÔNG gọi LLM extract fact từ transcript.** Tốn token, ghi rác, khó kiểm soát. Ghi memory là quyết định ngữ nghĩa → agent chủ động, dạy bằng `skills/agent-memory/SKILL.md`. Hook chỉ làm phần cơ học: inject, nhắc, validate.

### Frontmatter chuẩn — forward-compat Phase 2

```yaml
id: <slug ổn định>
type: decision | person | reference | log | project
layer: L1 | L2 | L3          # ánh xạ Tencent
visibility: private | team | restricted
owner: <role>
grants: [<role>, ...]        # khi restricted
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: []
source: <link | session id>
```
Phase 2 index (SQLite FTS5 + sqlite-vec) **derive** từ files; markdown vẫn là source of truth. Chuẩn frontmatter từ đầu ⇒ Phase 2 không phải viết lại kho.

## 5. Phương án đã cân nhắc

| Phương án | Ưu | Nhược | Kết luận |
|---|---|---|---|
| Clone Tencent full ngay | mạnh, có vector search, panel | vài tuần dev, Docker, 2 API key, bảo trì > sử dụng | **Loại** — Phase 2 |
| Files + SQLite FTS5 ngay | search nhanh | ~3x phức tạp, chưa có >300 file | **Hoãn** — chờ tín hiệu scale |
| Markdown + skill + hook | git-versionable, human-editable, debug bằng mắt, dựng 2-3 ngày | search chỉ grep | ✅ **Chọn** |
| Subagent in-process | rẻ, 1 phiên | **ACL vô hiệu** | Loại cho agent có identity; vẫn dùng cho việc vặt vô danh |
| Identity key theo tên | trực quan | đổi tên = đổi path + recompile ACL | Loại |
| Identity key theo vai trò | tên là field, ACL gắn vai, ổn định | phải giữ 1:1 vai↔agent | ✅ **Chọn** |

## 6. Rủi ro & cách chặn

| # | Rủi ro | Mức | Chặn |
|---|---|---|---|
| 1 | **Self-escalation** — agent sửa `loadout.yaml`/`settings.json` của chính nó để mở quyền | P0 | `deny: Edit(./loadout.yaml)`, `Edit(./.claude/**)`; `compile-acl.sh` chạy từ root, không từ trong phiên agent |
| 2 | **deny thắng allow** ⇒ không viết được "deny `private/**`, allow `private/<mình>/**`". Phải enumerate anh em: `deny: Read(../../memory/private/main/**)` | P0 | Thêm vai mới ⇒ **recompile TẤT CẢ vai**. Bắt buộc qua script, cấm sửa tay `settings.json` |
| 3 | **Bash bypass** — `deny Read()` không chặn `cat` | P0 | `acl-guard.cjs` PreToolUse. (Pattern đã chứng minh: `scout-block.cjs` của alp chặn được `.git`/`node_modules`) |
| 4 | **Fact duplication** — silo làm 2 agent ghi cùng 1 fact về principal ở 2 nơi rồi lệch nhau | P1 | Luật cứng: fact về principal/project **LUÔN** vào `shared/` hoặc `projects/`. `private/` chỉ chứa working notes + self-log. Enforce bằng `write:` grant, không cấp write `private/` cho fact loại team |
| 5 | Journal phình, nhiễu context | P1 | 1 file/tháng, mỗi entry ≤5 dòng, >200 dòng thì nén. Journal **không** nằm trong boot set |
| 6 | N agent = N phiên = N lần đốt context boot | P1 | Giữ boot set ≤7 file / ~4k token. `_shared/` chống lặp nội dung |
| 7 | Identity drift giữa `_shared` và `<role>` | P2 | `doctor.sh` cảnh báo khi `<role>/SOUL.md` lặp nội dung `_shared/VOICE.md` |
| 8 | Migrate Phở làm hỏng đường dẫn trong CLAUDE.md/BOOTSTRAP | P2 | Migrate 1 vai trước, chạy thử 1 phiên thật, rồi mới thêm vai 2 |

## 7. Lộ trình

| Phase | Nội dung | Ước lượng |
|---|---|---|
| **P0** | Scaffold cây thư mục; migrate `agent-team/pho` → `identity/main` + `memory/`; tách `_shared/`; chưa hook chưa ACL. Chạy thử 1 phiên. | ~0.5 ngày |
| **P1** | `loadout.yaml` schema + `compile-acl.sh` → `.claude/settings.json`. Test cách ly bằng Read. | ~0.5 ngày |
| **P2** | `hooks/session-start.cjs` + `acl-guard.cjs` + `skills/agent-memory/SKILL.md`. Test bypass bằng `cat`. | ~1 ngày |
| **P3** | Thêm vai `researcher` (Long). `new-role.sh`. Test delegate qua herdr + recompile ACL toàn bộ. | ~0.5 ngày |
| **P4** *(sau)* | SQLite FTS5 index, embedding, panel. **Chỉ khi** `memory/` > ~300 file hoặc grep bắt đầu chậm/sót. | — |

## 8. Tiêu chí thành công

- `new-role.sh <slug>` tạo vai mới chạy được **< 2 phút**.
- Boot context 1 agent **≤ ~4k token**.
- **Test cách ly bắt buộc:** phiên `researcher` KHÔNG đọc được `memory/private/main/**` bằng cả `Read` **lẫn** `Bash(cat)`. Fail 1 trong 2 = ACL chưa xong.
- Đổi `name: Phở` → tên khác: sửa **1 dòng**, 0 file path thay đổi, 0 recompile.
- `doctor.sh` sạch (không DRIFT/STALE/ORPHAN) sau mỗi phiên.
- Principal không phải giải thích lại điều gì lần thứ 2 — thước đo thật của memory.

## 9. Phụ thuộc

- Claude Code hỗ trợ `permissions.additionalDirectories` + `deny` + `PreToolUse`/`SessionStart` hooks — **đã verify docs, chưa verify runtime**. Verify ở P1 trước khi xây tiếp.
- `herdr` (đã có) cho giao tiếp giữa các phiên agent.
- `skills/` canonical store của Phở — tái dùng, không dựng lại.

## 10. Câu chưa chốt

1. Vai thứ 2 là `researcher` (Long) — còn vai nào nữa cần dựng ngay ở P3, hay chỉ 2 vai trước?
2. `memory/private/<role>/` có cần git-track không? Track = principal review được; không track = agent thoải mái ghi nháp.
3. Khi Long ghi `projects/<slug>/refs/`, Phở có cần cơ chế duyệt (review queue) hay tin thẳng?
4. `agent-team/` sau migrate: xoá, hay giữ read-only làm bản lưu?

---

## Nguồn

- [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
- [TencentDB Agent Memory Complete Guide — Dashen Tech](https://dashen-tech.com/en/dev-tools/tencentdb-agent-memory-guide-2026/)
- [Claude Code — Settings & permissions](https://code.claude.com/docs/en/settings)
- [Claude Code — Hooks](https://code.claude.com/docs/en/hooks)
