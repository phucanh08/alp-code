---
title: Giới thiệu
description: ALP là lớp điều phối code-native cho Claude Code và Codex CLI.
---

ALP là launcher code-native cho một nhóm agent dùng chung policy, workflow và memory. Bạn chọn độ khó của công việc; ALP chuẩn bị identity và quyền trước khi chuyển execution cho Claude Code hoặc Codex CLI.

ALP không thay thế hai runtime đó. Nó giữ phần điều phối ở một lớp riêng để cùng một role có hành vi và giới hạn nhất quán, dù model của role chạy ở runtime nào.

## ALP mang lại gì?

- **Một lệnh để bắt đầu:** `alp` mở coordinator mặc định trong project hiện tại.
- **Quyền có thể kiểm tra:** tools, skills, memory và workspace được chốt trước khi runtime chạy.
- **Specialist có ranh giới:** delegation luôn đi qua policy; role không được tự mở rộng quyền.
- **Context có continuity:** quyết định và ràng buộc quan trọng có thể sống qua compaction mà không sao chép cả transcript.
- **Project mở rộng được:** custom agent và skill nằm trong `.alp/`, review được như source code.

## Mental model

```text
Bạn chọn mode và giao việc
  → ALP resolve AgentDefinition + policy
  → ALP chuẩn bị execution snapshot
  → model quyết định Claude Code hay Codex CLI
  → runtime thực thi trong đúng quyền đã cấp
```

Nếu role, tool, path hoặc memory scope không được khai báo, ALP từ chối thay vì tự đoán. Xem [ALP hoạt động thế nào](./concepts/how-alp-works/) để hiểu luồng đầy đủ.

## Bắt đầu nhanh

- Chưa có ALP? [Cài đặt và kiểm tra môi trường](./getting-started/installation/).
- Muốn mở phiên đầu tiên? Làm theo [Bắt đầu nhanh](./getting-started/quickstart/).
- Đã dùng ALP? Tra [CLI reference](./reference/cli/) hoặc [xử lý sự cố](./reference/troubleshooting/).
- Muốn thử phần đang phát triển? Xem [Custom agent](./guides/custom-agents/) và [skill của project](./guides/project-skills/) trên source sau `v0.10.4`.

## Ranh giới quan trọng

:::caution[Policy có hiệu lực trước prompt]
Một yêu cầu trong prompt không thể sửa policy đã chốt: muốn thêm tool, workspace hay private memory thì sửa definition và đi qua trust flow, đừng tìm đường vòng trong runtime.

Mức cưỡng chế thì tuỳ runtime. Claude Code từ chối tool và read root ngoài grant ngay lúc gọi; trên Codex CLI hai phần đó là ràng buộc mức prompt, chỉ ghi và egress mạng bị sandbox chặn thật. Xem [runtime nào cưỡng chế phần nào](./concepts/agents-and-authority/#runtime-nào-cưỡng-chế-phần-nào).
:::
