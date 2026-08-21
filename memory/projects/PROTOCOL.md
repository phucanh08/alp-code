# PROJECT LAYER — Giao thức

> Cách Phở biết về các project mà không đốt hết context.
> Mô hình: **progressive disclosure 3 tầng**, kiểm soát bằng `modified`.
> Tham chiếu: Hermes Agent skills system (L0 index → L1 content → L2 refs).

## 1. Ba tầng

| Tầng | File | Khi nào nạp | Ngân sách |
|---|---|---|---|
| **L0 — INDEX** | `projects/INDEX.md` | **Luôn**, ở bước boot | ≤ 1 dòng/project, mục tiêu < 2k token kể cả khi có 30 project |
| **L1 — CARD** | `projects/<slug>/PROJECT.md` | Khi project đó nằm trong phạm vi phiên | ≤ 60 dòng |
| **L2 — REFS** | `projects/<slug>/{decisions,log,refs}/*.md` | Chỉ khi cần đúng file đó | tuỳ ý |

**Luật vàng:** không bao giờ nạp L1 của mọi project. Đọc L0, xác định project liên quan,
chỉ mở L1 của nó. L2 chỉ mở khi L1 trỏ tới và câu hỏi thật sự cần.

Nếu principal hỏi "tình hình chung thế nào?" → **chỉ cần L0**. Mở L1 lúc này là lãng phí.

## 2. Vì sao L0 phải ổn định

L0 nằm trong phần đầu context mỗi phiên. Mỗi lần nó đổi byte, prompt cache hỏng và toàn bộ
phần sau phải tính lại. Nên:

- **L0 chỉ đổi khi trạng thái project đổi thật** — không sửa vì lý do vụn vặt.
- **Ngày trong L0 ghi theo ngày, không ghi giờ** (`2026-08-14`, không `2026-08-14 13:55`).
  Timestamp mịn hơn ngày sẽ phá cache mỗi lần chạm file.
- **Thông tin hay đổi không đặt ở L0** — tiến độ chi tiết, việc đang làm, ghi chú phiên
  thuộc về L1/L2.
- Sắp xếp hàng trong bảng **cố định** (theo priority rồi slug), không sắp lại tuỳ hứng.

## 3. Kiểm soát bằng `modified`

Có hai đồng hồ, và chúng phải khớp nhau:

| Đồng hồ | Ai ghi | Ý nghĩa |
|---|---|---|
| `updated:` trong frontmatter L1 | **Phở**, thủ công | "Lần cuối Phở thật sự xem lại và xác nhận nội dung này đúng" |
| mtime của file (hệ thống) | Máy | "Lần cuối file bị chạm vào" |

### Ba tín hiệu

**DRIFT** — `mtime > updated`
File đã bị sửa mà `updated` chưa được cập nhật. Nghĩa là có người (hoặc agent khác) sửa
ngoài quy trình, hoặc Phở sửa mà quên đóng dấu. → Đọc lại L1, xác nhận nội dung, cập nhật
`updated`, đồng bộ lại dòng L0 nếu cần.

**STALE** — `status: ACTIVE` và `updated` cách hôm nay > 14 ngày
Project khai là đang chạy nhưng không ai đụng tới hai tuần. Một trong hai điều sai: hoặc
trạng thái sai, hoặc project thật sự bị bỏ quên. → Nêu trong heartbeat, hỏi principal.

**ORPHAN** — có `PROJECT.md` mà không có dòng trong L0, hoặc ngược lại
→ Đồng bộ ngay. L0 là nguồn sự thật về *danh sách*; L1 là nguồn sự thật về *nội dung*.

### Công cụ

```bash
scripts/sync-project-index.sh          # quét, báo cáo DRIFT / STALE / ORPHAN
scripts/sync-project-index.sh --write  # ghi lại bảng L0 từ frontmatter L1
```

Chạy ở bước boot (rẻ, chỉ đọc frontmatter) và trong mỗi heartbeat.
`--write` chỉ đụng vùng giữa `<!-- BEGIN:INDEX -->` và `<!-- END:INDEX -->`.

## 4. Cấu trúc một project

```
projects/<slug>/
├── PROJECT.md          L1 — card, có frontmatter
├── decisions/          L2 — mỗi quyết định một file, YYMMDD-slug.md
├── log/                L2 — nhật ký phiên, YYYY-MM.md (gộp theo tháng)
└── refs/               L2 — link, spec, tài liệu ngoài
```

Thư mục L2 tạo khi cần, không tạo sẵn cho rỗng.

## 5. Frontmatter L1 — bắt buộc

```yaml
---
slug: ten-project              # trùng tên thư mục
name: Tên đầy đủ
status: ACTIVE                 # ACTIVE | WAITING | BLOCKED | PAUSED | DONE
priority: P1                   # P0 khẩn | P1 chính | P2 phụ | P3 nền
summary: Một câu ≤ 100 ký tự — dòng này lên thẳng L0
path: ~/AnhlpProjects/ten-project
updated: 2026-08-14            # ngày, không giờ
---
```

`summary` là thứ duy nhất từ L1 được phép leo lên L0. Viết nó cho người đọc lướt: nói
project *làm gì*, không nói nó *đang ở đâu* (trạng thái đã có cột riêng).

## 6. Vòng đời

**Thêm project**
1. `cp -r projects/_template projects/<slug>`
2. Điền frontmatter + card
3. `scripts/sync-project-index.sh --write`

**Đổi trạng thái**
Sửa `status` + `updated` ở L1 → `--write` → L0 tự cập nhật. Không sửa tay L0.

**Đóng project**
`status: DONE` → `--write` đẩy nó xuống mục Đã đóng ở L0 (một dòng, không chi tiết).
Giữ thư mục lại; lịch sử có giá.

## 7. Ranh giới với phần còn lại của `memory/`

Dễ nhầm, nên nói rõ:

| Thuộc về | Đặt ở |
|---|---|
| Bất cứ thứ gì gắn với **một** project | `memory/projects/<slug>/` |
| Fact xuyên project (người, tài khoản, quyết định chung) | `memory/shared/` |
| Sở thích ổn định của principal | `identity/_shared/PRINCIPAL.md` |
| Nháp chưa kiểm chứng của một vai | `memory/private/<role>/` |

Một fact chỉ có một nhà. Luật đầy đủ: skill `agent-memory`.

**Quyền ghi khác nhau theo vai.** `PROJECT.md` (L1) và `decisions/` là quyền của
chief-of-staff. `refs/` mở cho vai research. Xem `identity/<role>/loadout.yaml`.

## 8. Chú giải L0

**Trạng thái:** `ACTIVE` đang làm · `WAITING` chờ bên ngoài · `BLOCKED` cần principal gỡ ·
`PAUSED` cố ý dừng · `DONE` đã đóng
**Ưu tiên:** `P0` khẩn · `P1` chính · `P2` phụ · `P3` nền
