# P3 — new-role.sh + vai researcher (Long) + test cách ly

**Mục tiêu:** chứng minh hệ nhân bản được và cách ly thật.
**Phụ thuộc:** P2.
**Đây là phase chứng minh cả plan đúng hay sai.** P0–P2 chỉ là chuẩn bị.

---

## 3.1 `scripts/new-role.sh`

```
new-role.sh <role-slug> [--name <Tên>] [--emoji <e>] [--model <id>]
```

```
1. validate slug: kebab-case, chưa tồn tại, không bắt đầu bằng "_"
2. cp -r identity/_template identity/<slug>
3. thay {{ROLE}} {{NAME}} {{EMOJI}} {{MODEL}} trong mọi file
4. mkdir -p memory/private/<slug>
5. thêm dòng vào identity/REGISTRY.md
6. scripts/compile-acl.sh          # --all — BẮT BUỘC, recompile MỌI vai
7. scripts/doctor.sh
8. in: "Vai <slug> sẵn sàng. Chạy: cd identity/<slug> && claude"
9. nhắc: "Sửa SOUL.md + PLAYBOOK.md + loadout.yaml rồi chạy lại compile-acl.sh"
```

**Bước 6 không được bỏ.** Thiếu nó = mọi vai cũ vẫn đọc được `memory/private/<slug>/` (rủi ro #2).
`new-role.sh` là con đường **duy nhất** để thêm vai. Tạo tay = rò rỉ. Ghi luật này vào `CHARTER.md`.

---

## 3.2 Vai `researcher` — Long 🔎

`identity/researcher/loadout.yaml`:
```yaml
role: researcher
name: Long
emoji: 🔎
model: claude-opus-5
reports_to: main
delegates_to: []
memory:
  read:  [shared/**, projects/**]
  write: [shared/reference/**, projects/*/refs/**]
tools:  [Read, Write, Edit, Glob, Grep, Bash, WebSearch, WebFetch]
skills: [agent-memory, alp:research, alp:docs-seeker, alp:scout]
```

**Vì sao `write` hẹp:** Long tra cứu, không quyết định. Nó ghi `shared/reference/` và
`projects/*/refs/` — tức là *tài liệu*. `decisions/` và `PROJECT.md` là quyền của main.
(`private/researcher/**` tự thêm, không cần khai.)

Nội dung riêng cần viết:
- `SOUL.md` — Long ≠ Phở. Tính cách researcher: hoài nghi nguồn, phân biệt rõ "đọc được"
  vs "suy ra", luôn kèm link, không kết luận vượt dữ liệu.
- `PLAYBOOK.md` — quy trình research: xác định câu hỏi → tìm nguồn sơ cấp → đối chiếu chéo
  → viết report vào `projects/<slug>/refs/` → báo cáo ngắn cho Phở.
- `RELATIONS.md` — nhận việc từ `main`; không delegate cho ai.

Cập nhật `identity/main/`:
- `loadout.yaml` → `delegates_to: [researcher]`
- `RELATIONS.md` → khi nào giao cho Long, giao thế nào (herdr), kiểm chứng ra sao

---

## 3.3 Test cách ly — nghiệm thu chính của cả plan

Chạy `scripts/test-isolation.sh`. **Fail 1 ca = P3 chưa xong.**

### Nhóm CHẶN (từ phiên `researcher`)

| # | Hành động | Kỳ vọng |
|---|---|---|
| 1 | `Read` `memory/private/main/*` | DENY |
| 2 | `cat memory/private/main/*` | DENY |
| 3 | `cd` rồi `cat *` | DENY |
| 4 | `cat $(echo …)` | DENY (indirection) |
| 5 | symlink rồi đọc | DENY (realpath) |
| 6 | `Edit identity/researcher/loadout.yaml` | DENY |
| 7 | `Edit identity/researcher/.claude/settings.json` | DENY |
| 8 | `Read identity/main/SOUL.md` | DENY |
| 9 | `Edit identity/_shared/HOUSE-RULES.md` | DENY |
| 10 | `Edit memory/projects/<slug>/PROJECT.md` | DENY (ngoài `write` grant) |
| 11 | `Edit hooks/acl-guard.cjs` | DENY |

### Nhóm CHO PHÉP — quan trọng ngang nhóm trên

| # | Hành động | Kỳ vọng |
|---|---|---|
| 12 | `Read memory/shared/reference/*` | ALLOW |
| 13 | `Write memory/shared/reference/moi.md` | ALLOW |
| 14 | `Write memory/projects/<slug>/refs/moi.md` | ALLOW |
| 15 | `Write memory/private/researcher/nhap.md` | ALLOW |
| 16 | `Read memory/projects/INDEX.md` | ALLOW |
| 17 | `Read identity/_shared/PRINCIPAL.md` | ALLOW |

### Nhóm main

| # | Hành động | Kỳ vọng |
|---|---|---|
| 18 | `Read memory/private/researcher/*` | **DENY** — cách ly hai chiều, main không phải root |
| 19 | `Edit memory/projects/<slug>/PROJECT.md` | ALLOW |
| 20 | `Read memory/private/main/*` | ALLOW |

Ca 18 dễ bị bỏ sót. Main **không** có đặc quyền đọc kho riêng của Long — muốn biết
thì hỏi Long. `private` mà cấp trên đọc được thì không còn là `private`.

**Chạy `test-isolation.sh` ở cả `default` mode và mode bạn dùng thật.** Nếu spike 1.0 cho thấy
deny hỏng ở bypass mà bạn vẫn chạy bypass → phải pass hoàn toàn nhờ hook.

---

## 3.4 Test luồng thật (không chỉ ACL)

1. Phở nhận yêu cầu research → giao Long qua herdr.
2. Long research, ghi `memory/projects/<slug>/refs/<slug>.md`.
3. Long báo cáo xong.
4. **Phở đọc được file đó ngay** — chứng minh shared namespace hoạt động.
5. Phở kiểm chứng, viết `decisions/` (quyền Phở, Long không có).
6. `doctor.sh` sạch.

Không chạy được luồng này = hệ đúng về bảo mật nhưng vô dụng về công năng.

---

## 3.5 Test đổi tên

Sửa `identity/main/loadout.yaml`: `name: Phở` → `name: Bún`.

- [x] **Chỉ 1 dòng đổi**
- [x] Không path nào đổi
- [x] `compile-acl.sh --check` → **không** báo lệch (tên không ảnh hưởng ACL)
- [x] Mở phiên → agent tự xưng "Bún"
- [x] Đổi ngược lại về `Phở`

Đây là bằng chứng quyết định "key theo vai trò" đúng.

---

## 3.6 Dọn dẹp

- [x] Xoá vai giả `qa` nếu còn từ P1
- [x] `identity/REGISTRY.md` khớp thực tế
- [x] `README.md` + `CHARTER.md` cập nhật: có 2 vai, cách thêm vai, **luật bắt buộc dùng `new-role.sh`**
- [x] Ghi `memory/shared/decisions/260821-agent-memory-architecture.md` — chốt kiến trúc + lý do
- [ ] **Hỏi principal** về `agent-team/` (xoá / giữ read-only) — câu hỏi mở #4, không tự quyết
- [ ] Commit — **chờ principal duyệt**

---

## 3.7 Nghiệm thu P3

- [x] 20/20 ca test cách ly đúng
- [ ] Luồng thật 3.4 chạy trọn vẹn
- [x] Test đổi tên 3.5 đạt
- [x] `new-role.sh qa` < 2 phút, `settings.json` mọi vai tự có deny cho `qa`
- [x] `doctor.sh` sạch
- [ ] Phở hoạt động không kém trước migrate

### Kết quả verify lại — 2026-08-21

- `new-role.sh qa` chạy trong sandbox sạch trong 1 giây; cả ba settings enumerate deny của
  hai vai còn lại; registry, trust và doctor đều đạt. Workspace thật không có fixture `qa`.
- `new-role.sh` giờ fail-fast nếu compile/trust/doctor lỗi; `trust-role.sh` hỗ trợ cả máy mới
  chưa có `~/.claude.json`.
- Test đổi tên: hook boot nhận `Bún`, `compile-acl.sh --check` vẫn sạch, không path đổi;
  sau test đã trả đúng một dòng về `name: Phở`.
- Luồng quyền của 3.4 đã được suite chứng minh: researcher ghi `projects/*/refs`,
  main đọc vùng projects và ghi decisions/L1. Luồng Claude + herdr end-to-end và
  kiểm tra hồi quy hành vi Phở còn chờ quota Claude reset; không đánh dấu khống hai mục này.
