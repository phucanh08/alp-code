---
status: completed
created: 2026-08-21
slug: multi-agent-identity-memory
source: plans/reports/brainstorm-260821-0930-multi-agent-identity-memory.md
blockedBy: []
blocks: []
---

# Agent Memory — Multi-agent Identity + Memory + ACL

## Tổng quan

Xây `agent-memory/`: hệ identity + memory dùng chung cho nhiều agent, mỗi agent chạy 1 phiên
Claude Code riêng với CWD riêng, ACL được harness enforce.

Nguồn sự thật: [brainstorm](../reports/brainstorm-260821-0930-multi-agent-identity-memory.md).
Migrate từ `~/AnhlpProjects/agent-team/pho` (Phở, main — bộ file đã hoàn chỉnh, tái dùng tối đa).

**Ngoài phạm vi:** SQLite FTS5, vector search, web panel, auto-extract bằng LLM, Code-Graph. Tất cả là P4/sau.

## Nguyên tắc bất biến

1. **Key theo vai trò, không theo tên.** `identity/main/` ← `name: Phở`. Phase 1: 1 vai = 1 agent.
2. **`loadout.yaml` là nguồn sự thật duy nhất của ACL.** `.claude/settings.json` là sản phẩm sinh ra, không sửa tay, không commit.
3. **Markdown là source of truth.** Mọi index/cache đều derive được, xoá đi sinh lại được.
4. **Fact về principal/project luôn vào `shared/` hoặc `projects/`.** `private/` chỉ chứa nháp + self-log.
5. **Hook làm việc cơ học, agent làm việc ngữ nghĩa.** Hook không gọi LLM.
6. **Boot set ≤ 7 nguồn / ~4k token.** Không nạp cả `memory/`, không nạp cả `projects/`.

## ⚠️ Phát hiện phải verify TRƯỚC khi xây tiếp (P1.0)

Phiên hiện tại chạy `bypassPermissions` và hook `PreToolUse` của plugin alp (`scout-block.cjs`)
**vẫn chặn được** truy cập `.git`/`node_modules`. ⇒ **Hook fire kể cả ở bypass mode.**

Chưa rõ `permissions.deny` có còn hiệu lực ở `bypassPermissions` hay không. Hai khả năng:

| Nếu | Hệ quả |
|---|---|
| deny **còn** hiệu lực ở mọi mode | settings = lớp chính, hook = lớp 2. Kiến trúc như thiết kế. |
| deny **bị bỏ qua** ở bypass mode | **`acl-guard.cjs` là lớp enforce DUY NHẤT.** Phải mở rộng hook phủ cả `Read/Edit/Write/Glob/Grep`, không chỉ `Bash`. Và ghi luật: phiên agent **cấm** chạy bypass. |

**P1.0 là spike bắt buộc.** Kết quả quyết định độ nặng của P2. Không được đoán.

## Giới hạn đã biết — nói thẳng

`acl-guard.cjs` là **guardrail, không phải sandbox**. Regex trên chuỗi lệnh Bash không chống nổi
agent cố tình lách (`eval`, `$(...)`, symlink, base64, `sh -c`, đọc qua ngôn ngữ script khác).
Nó chặn *nhầm lẫn và vượt quyền tình cờ*. Muốn cách ly thật với agent thù địch → OS user riêng
hoặc container, **ngoài phạm vi plan này**.

## Các phase

| Phase | Nội dung | Ước lượng | Phụ thuộc |
|---|---|---|---|
| [P0](phase-0-scaffold-migrate.md) | Scaffold cây thư mục + migrate Phở → `identity/main` + `memory/` chung | ~0.5 ngày | — |
| [P1](phase-1-loadout-acl.md) | **Spike verify deny×bypass** → `loadout.yaml` schema → `compile-acl.sh` | ~0.5 ngày | P0 |
| [P2](phase-2-hooks-skill.md) | `session-start.cjs` · `acl-guard.cjs` · `skills/agent-memory/SKILL.md` · `doctor.sh` | ~1 ngày | P1 |
| [P3](phase-3-researcher-role.md) | `new-role.sh` → vai `researcher` (Long) → test cách ly | ~0.5 ngày | P2 |

## Nghiệm thu toàn cục

Hoàn thành khi **tất cả** đúng:

- [ ] Phiên `researcher` **không** đọc được `memory/private/main/**` bằng `Read` **lẫn** `Bash(cat)`. Fail 1 trong 2 = chưa xong.
- [ ] Phiên `researcher` **không** sửa được `identity/researcher/loadout.yaml` và `identity/researcher/.claude/settings.json`.
- [ ] Phiên `main` đọc/ghi được `memory/shared/**`, `memory/projects/**`, `memory/private/main/**`.
- [ ] `scripts/new-role.sh qa` tạo vai chạy được **< 2 phút**, và tự recompile ACL của **mọi** vai.
- [ ] Đổi `name: Phở` → tên khác: sửa **1 dòng**, 0 path đổi, 0 recompile.
- [ ] Boot context 1 agent ≤ **~4k token** (hook tự cảnh báo khi vượt).
- [ ] `scripts/doctor.sh` sạch: không DRIFT / STALE / ORPHAN / ACL-DRIFT.
- [ ] Phở chạy được như trước migrate — không mất bối cảnh, không mất memory.

## Rủi ro

| # | Rủi ro | Mức | Xử ở |
|---|---|---|---|
| 1 | Self-escalation — agent sửa `loadout.yaml`/`settings.json` của chính nó | P0 | P1 (deny) + P2 (hook) |
| 2 | `deny` thắng `allow` ⇒ phải enumerate vai anh em ⇒ thêm vai = recompile TẤT CẢ | P0 | P1 (`--all` mặc định) + P2 (doctor báo ACL-DRIFT) |
| 3 | Bash bypass — `deny Read()` không chặn `cat` | P0 | P2 (`acl-guard.cjs`) |
| 4 | deny có thể vô hiệu ở bypass mode | P0 | **P1.0 spike** |
| 5 | Fact duplication giữa `shared/` và `private/` | P1 | P2 (SKILL.md + `write:` grant) |
| 6 | Migrate làm hỏng đường dẫn trong file Phở | P1 | P0 (grep toàn bộ path cũ, chạy thử 1 phiên thật trước khi thêm vai 2) |
| 7 | `settings.json` chứa path tuyệt đối → hỏng khi move repo | P2 | P1 (gitignore + doctor phát hiện path lệch → recompile) |
| 8 | Boot context phình khi thêm vai | P1 | P2 (hook đo và cảnh báo) |

## Câu hỏi mở (chưa chặn P0–P2, cần trả lời trước P3)

1. Ngoài `researcher` (Long), P3 dựng thêm vai nào không?
2. `memory/private/<role>/` có git-track không? (track = principal review được; không track = agent thoải mái ghi nháp)
3. Long ghi `memory/projects/<slug>/refs/` — cần review queue hay tin thẳng?
4. `agent-team/` sau migrate: xoá, hay giữ read-only làm bản lưu?
