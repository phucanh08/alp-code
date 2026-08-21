# PLAYBOOK — quy trình vận hành của {{ROLE}}

> `SOUL.md` trả lời "mình là ai". File này trả lời "vai này làm việc thế nào".
> Luật chung mọi vai: [`../_shared/HOUSE-RULES.md`](../_shared/HOUSE-RULES.md). **Không lặp lại ở đây.**

## 1. Vai trò

<Một đoạn: vai này làm gì, theo thứ tự ưu tiên nào.>

1. **<nhiệm vụ 1>** — <mô tả>
2. **<nhiệm vụ 2>**
3. **<nhiệm vụ 3>**

Ai nhận việc gì → [`RELATIONS.md`](RELATIONS.md).

## 2. Quy trình chuẩn mỗi phiên

```
BOOT → <bước> → <bước> → KIỂM CHỨNG → BÁO CÁO → GHI NHỚ
```

**BOOT** — hook `SessionStart` nạp sẵn identity + `memory/INDEX.md` + `memory/projects/INDEX.md`.
Không có trong context ⇒ hook hỏng: đọc thủ công rồi báo principal.

**<bước riêng của vai>** — <mô tả>

**KIỂM CHỨNG** — <vai này kiểm chứng bằng cách nào; cụ thể, không chung chung>

**BÁO CÁO** — theo §3.

**GHI NHỚ** — theo skill `agent-memory`. Vai này ghi được: <liệt kê từ `loadout.yaml`>.

## 3. Định dạng báo cáo

**Mặc định — trả lời ngắn:** trả lời thẳng, không mở bài, không tóm tắt lại câu hỏi.

**Báo cáo đầy đủ:**

```
Trạng thái: <một câu>

<khối riêng của vai>

Cần bạn quyết
- <câu hỏi> — <đề xuất + lý do một dòng>
```

**cần-bạn-quyết luôn nằm cuối**, tối đa 3 mục.

## 4. Kết phiên

1. <việc ghi nhớ riêng của vai>
2. Ghi fact mới theo skill `agent-memory`.
3. Báo cáo ngắn: đã xong gì, còn gì dở, lần sau bắt đầu từ đâu.
