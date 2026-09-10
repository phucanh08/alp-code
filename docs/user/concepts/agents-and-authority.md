---
title: Agent và quyền
description: Hiểu built-in roles, capability grants và policy boundaries của ALP.
---

Agent trong ALP là một role có definition, không phải một model process tự do. Definition trả lời role là ai, được dùng gì, đọc/ghi ở đâu, delegate cho ai và phải kết thúc theo workflow nào.

## Built-in roles

| Role | Trách nhiệm |
|---|---|
| `main` | Coordinator làm việc trực tiếp với principal: brainstorm, cắt việc, kiểm chứng kết quả trả về |
| `worker` | Thực thi một task đã được `main` giao, từ đầu tới hết |
| `search` | Tìm code và call site trong local repository |
| `librarian` | Nghiên cứu nguồn ngoài hoặc cross-repo |
| `read-thread` | Truy xuất quyết định và fact trong memory |
| `review` | Review code theo một concern có bằng chứng |
| `oracle` | Second opinion sâu cho quyết định khó |
| `compaction` | Tóm tắt context theo contract |
| `titling` | Sinh title ngắn |

`main` có thể delegate tới các role trên. Specialist không tự có quyền delegate chỉ vì đang làm thay `main`; quan hệ phải tồn tại trong definition.

`main` **không ghi được vào workspace**: nó không cầm `Write`/`Edit` và không khai write root nào. Mọi thay đổi file đi qua `worker` — vai duy nhất khai `writeRoots: ["."]`. Đây là một ranh giới kiểm được ở lớp policy, không phải một câu trong prompt: một `main` cố ghi bị `PolicyEngine` từ chối với `WORKSPACE_NOT_GRANTED`, và `alp` hạ luôn phiên `main` xuống `read-only` kể cả trong project đã đăng ký.

## Sáu nhóm capability

1. **Tools:** tên tool role được gọi.
2. **Skills:** workflow/instruction package role được nạp.
3. **Memory:** logical scope role được đọc hoặc ghi.
4. **Workspace:** root được đọc/ghi và execution mode thực tế.
5. **Delegation/subagent/MCP:** capability phải vừa được khai vừa tồn tại trong catalog.
6. **Workflow:** tool còn phải được phép tại state hiện tại.

Write grant luôn phải nằm trong read grant tương ứng. Tên capability không tồn tại bị từ chối thay vì bỏ qua.

## Runtime nào cưỡng chế phần nào

Grant được chốt như nhau ở lớp ALP, nhưng hai runtime không giữ được cùng một lượng. Đây là giới hạn của Codex, không phải lỗi cấu hình.

| Phần của bảng Authority | Claude Code | Codex CLI |
|---|---|---|
| Tool grant | ACL thật — tool ngoài grant bị từ chối lúc gọi | **Không cưỡng chế được:** shell là built-in, vai không có `Bash` vẫn chạy được lệnh |
| Read root và private memory | ACL thật — đọc ngoài root bị từ chối | **Không cưỡng chế được:** sandbox read-only cho đọc mọi path |
| Ghi ngoài write root | ACL thật | Sandbox từ chối |
| Egress mạng | Không có tool mạng | Sandbox từ chối |

Đo ngày 2026-09-10 trên `alp-code`, không suy từ tài liệu: một vai chỉ có `Read, Glob, Grep, Skill` đã chạy `/bin/zsh -lc "… node -e …"` trên Codex và thành công.

Nghĩa là trên Codex, tool grant và read root là **ràng buộc mức prompt**; ghi và egress thì sandbox giữ thật. Từ tier 2, `alp agent test` và `alp agent add` in khối **Enforced by** ngay dưới bảng Authority để nói đúng phần nào được runtime nào cưỡng chế:

```text
  Enforced by
    - claude: the tool grant, the skill names and the read roots are ACL rules the runtime
              refuses at call time
    - codex: the shell is built in and cannot be withheld — this role holds no `Bash`, and a
             command can still run
    - codex: the read-only sandbox permits reading any path, so `workspace.readRoots` is
             instruction-level here
    - codex: writes outside the writable roots and network egress are refused by the sandbox
```

Khối này mô tả đúng policy đang xét, không phải cảnh báo chung: vai đã có `Bash` thì không bị nhắc "vẫn chạy lệnh được", vai memory-only thì nói về ranh giới của chính nó thay vì `readRoots`.

Khi giao việc nhạy cảm, hãy đọc [mapping mode → runtime](../modes-and-runtimes/) trước để biết vai đó chạy ở phía nào.

## Memory không kế thừa theo cấp bậc

- `shared` dành cho fact mọi role cần biết.
- `project:*` dành cho context của project.
- `private:<role>` chỉ role sở hữu đọc được.

Coordinator không được cấp quyền đọc private memory của specialist chỉ vì specialist báo cáo về coordinator. Kết quả cần chia sẻ phải được specialist trả qua output hoặc ghi vào scope được cấp.

Trên Claude, ranh giới này là ACL thật. Trên Codex nó là ràng buộc mức prompt vì sandbox read-only cho đọc mọi path — xem [runtime nào cưỡng chế phần nào](#runtime-nào-cưỡng-chế-phần-nào).

## Workspace của phiên main

`main` nhận `workspace-write` khi project đã được đăng ký bằng `alp init`. Cwd chưa đăng ký là read-only. Delegated role còn bị giới hạn bởi workspace mode và roots của chính execution đó.

## Kiểm agent trước khi chạy

```bash
alp agent show review
alp agent test review
```

`agent test` chạy tối đa ba tầng, không gọi model:

- Tier 1: static definition, grants, skill roots và model/runtime mapping.
- Tier 2: dry-run preparation, authority, **enforced by**, egress, cost và launch spec.
- Tier 3: các deny path phải trả đúng policy error.

Exit code `0` nghĩa là sạch; `1` nghĩa là có finding cần xử lý.

Tiếp theo: [Thiết lập project](../../guides/project-setup/) hoặc [Custom agent](../../guides/custom-agents/).
