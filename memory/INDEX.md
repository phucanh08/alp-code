# INDEX — mục lục trí nhớ dùng chung

> **Mục lục, không phải nơi chứa nội dung.** Mỗi dòng trỏ tới một file trong `shared/`.
> Hook `SessionStart` **lọc** file này theo `loadout.yaml` của vai đang chạy — mỗi vai chỉ
> thấy dòng trỏ tới thứ nó được đọc. Quy ước & luật ghi: [`README.md`](README.md).
>
> **Phạm vi:** chỉ fact **xuyên project**. Thứ gắn với một project ở `projects/<slug>/`.
> Nháp riêng của một vai ở `private/<role>/` và **không** được liệt kê ở đây.

## Quyết định chung

- [260821 Kiến trúc agent-memory](shared/decisions/260821-agent-memory-architecture.md) — identity theo vai, ACL sinh từ `loadout.yaml`, hook là lớp enforce
- [260821 alp-code Knowledge Retrieval](shared/decisions/260821-alp-code-knowledge-retrieval.md) — Search local code, Librarian external/cross-repo, Read Thread memory

## Con người & tổ chức

_Chưa có._

## Tham chiếu

- [Hành vi ACL của Claude Code](shared/reference/claude-code-acl-behavior.md) — đo thật: cú pháp `//`, trust dialog, deny × permission mode
- [OpenClaw workspace architecture](shared/reference/openclaw-architecture.md) — mô hình file identity được dựa theo
- [DeepSeek Harness (`dsh`)](shared/reference/deepseek-harness.md) — agent harness plugin-hoá trên nền Cordis; tham chiếu kiến trúc cho herdr

## Nhật ký phiên

_Chỉ giữ các mốc gần nhất. Diễn biến đầy đủ ở `projects/<slug>/log/`._

| Ngày | Nội dung chính |
|---|---|
| 2026-08-14 | Khởi tạo Phở — identity theo mô hình OpenClaw, Project Layer 3 tầng kiểm soát bằng `modified`; agent chỉ qua herdr; Codex cho nghiên cứu sâu |
| 2026-08-17 | Nạp hiểu biết về DeepSeek Harness (`dsh`). Chưa clone, chưa chạy thử |
| 2026-08-21 | **Migrate `agent-team/pho` → `agent-memory/`.** Identity tách theo vai, memory dùng chung, ACL sinh từ `loadout.yaml`. Spike ACL cho 4 phát hiện đổi kiến trúc |
