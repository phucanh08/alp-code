# Nguồn gốc

Các kỹ thuật trong skill này bắt nguồn từ mẫu agent của dự án Microsoft Amplifier, qua hai
lần thích nghi.

## Nguồn gốc

- **Dự án:** Amplifier — https://github.com/microsoft/amplifier
- **Commit:** `2adb63f858e7d760e188197c8e8d4c1ef721e2a6` (2025-10-10)
- **Giấy phép:** MIT

## Chuỗi thích nghi

```
Amplifier (agent JSON)  →  alp-plugin (skill tra cứu)  →  alp-code (skill của repo)
```

### Lần 1 — Amplifier → alp-plugin

Từ agent `insight-synthesizer`: `simplification-cascades` · `collision-zone-thinking` ·
`meta-pattern-recognition` · `inversion-exercise` · `scale-game`.

Mẫu điều phối: `when-stuck` — khớp triệu chứng bế tắc với kỹ thuật.

Đổi: agent sống lâu, xuất JSON có cấu trúc → tài liệu tra cứu quét được bằng mắt, dùng
được ngay, không cần công cụ riêng.

### Lần 2 — alp-plugin → alp-code (2026-08)

Đổi:

- Dịch sang tiếng Việt, khớp `compiled policy invariants` và `HOUSE-RULES.md`.
- Viết cho **một lượt gỡ bế tắc**, không gắn với tên vai nào — vai nào được cấp skill này
  là việc của `compiled AgentDefinition`, không phải của nội dung skill.
- Thêm ranh giới theo **loadout**, không theo tên vai: không cấp `Edit` thì sản phẩm là
  khuyến nghị, không phải thay đổi trong code.
- Thêm ví dụ lấy từ chính alp-code ở chỗ ví dụ gốc quá xa ngữ cảnh.
- Tách rõ "bế tắc tư duy" (dùng skill này) khỏi "thiếu bằng chứng" (dùng `alp-debug`).

**Giữ nguyên:** năm kỹ thuật lõi, mẫu nhận diện, quy trình áp dụng, và luật 3 lĩnh vực.

## Nhận định nền

Năng lực của một agent thực ra là **mẫu tư duy không phụ thuộc lĩnh vực**. Gói nó thành
"agent Amplifier", "skill alp-plugin" hay "một lượt gỡ bế tắc" thì kỹ thuật bên dưới vẫn
là một.

Đó cũng chính là `meta-pattern-recognition` áp dụng lên chính nó.
