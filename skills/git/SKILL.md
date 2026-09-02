---
name: git
description: Thao tác git với conventional commit — stage, quét secret, tách commit theo type/scope, push, PR, merge. Kích hoạt khi principal yêu cầu commit/push/mở PR, hoặc khi cần đọc trạng thái repo trước lúc bàn giao.
---

# git — commit có kỷ luật

Skill này cần `Write`/`Edit` và `Bash`. Execution policy không cấp đủ thì chỉ đọc được trạng thái
repo, không commit được.

## Cổng chặn — đọc trước mọi thứ khác

**Không commit, không push, trừ khi principal yêu cầu** (HOUSE-RULES §1.3).

Không có ngoại lệ nào kiểu "làm xong rồi commit luôn cho gọn". Viết code xong thì báo cáo
và dừng; principal quyết định có commit không.

Bốn hành động **luôn phải hỏi lại từng lần**, kể cả khi lần trước đã được duyệt
(HOUSE-RULES §1.2):

| Hành động | Vì sao |
|---|---|
| `git push` | ra ngoài máy, người khác thấy ngay |
| `--force`, `--force-with-lease` | ghi đè lịch sử của người khác |
| `merge` vào nhánh chính | khó đảo ngược, ảnh hưởng mọi người |
| `git reset --hard`, xoá nhánh | mất việc chưa lưu |

## Quy trình commit

### 1. Stage và nhìn

```bash
git add -A && git diff --cached --stat && git diff --cached --name-only
```

Đọc `--stat` trước khi viết message. Commit mà không biết mình đang commit gì là cách
nhanh nhất để kéo nhầm file sinh ra vào lịch sử.

### 2. Quét secret — bắt buộc, không bỏ

```bash
git diff --cached | grep -iE '(api[_-]?key|token|password|secret|credential)'
```

Có khớp → **DỪNG**, báo principal, đề xuất `.gitignore`. Không tự quyết định là "chắc chỉ
là tên biến".

Với alp-code còn hai thứ **không bao giờ được vào commit**:

- `memory/` — trí nhớ là dữ liệu cục bộ từng máy, đã có trong `.gitignore`.
- `dist/` và `~/.alp/executions/` — compiled output và machine-local execution state.

Thấy chúng trong `--cached` nghĩa là `.gitignore` hỏng. Báo principal, đừng tự `git rm`.

### 3. Quyết định tách commit

**Tách khi:** trộn nhiều type (`feat` + `fix`, code + docs) · nhiều scope (`agents` +
`runtime`) · trộn config/deps với code · trên 10 file không liên quan nhau.

**Một commit khi:** cùng type và scope, ≤ 3 file, ≤ 50 dòng.

### 4. Viết message

Conventional commit, **tiếng Việt** cho phần mô tả — khớp lịch sử repo:

```
fix: repoRoot của phiên + workspaces không còn path tuyệt đối
feat(acl): register alp-plugin workspace
docs: báo cáo chẩn đoán repoRoot
```

Thân commit trả lời **vì sao**, không phải **làm gì** — `git diff` đã nói làm gì rồi.
Có issue liên quan thì dẫn số.

Chuẩn đầy đủ: `references/commit-standards.md`.

## Mẫu báo cáo về principal

```
✓ staged: N file (+X/−Y dòng)
✓ secret: sạch
✓ commit: <hash> type(scope): mô tả
✗ push: CHƯA — chờ principal duyệt
```

Chưa push thì ghi rõ chưa push. Không viết mập mờ để principal tự hiểu là xong.

## Xử lý lỗi

| Lỗi | Làm gì |
|---|---|
| phát hiện secret | chặn commit, liệt kê file, báo principal |
| không có thay đổi | dừng, nói rõ, không tạo commit rỗng |
| push bị từ chối | đề xuất `git pull --rebase`, **hỏi trước khi chạy** |
| xung đột merge | báo principal, không tự chọn bên |

## Worktree

alp-code dùng worktree cho nhánh triển khai cô lập (`.worktrees/` đã trong `.gitignore`).
Stash stack **dùng chung** giữa mọi worktree — `git stash pop` trần có thể lấy nhầm việc
của phiên khác. Cần cất việc tạm thì tạo commit WIP, đừng stash.

## Tham chiếu

| File | Nội dung |
|---|---|
| `references/workflow-commit.md` | quy trình commit, logic tách |
| `references/workflow-push.md` | push và xử lý lỗi |
| `references/workflow-pr.md` | tạo PR, phân tích diff với remote |
| `references/workflow-merge.md` | merge nhánh |
| `references/commit-standards.md` | chuẩn conventional commit |
| `references/safety-protocols.md` | phát hiện secret, bảo vệ nhánh |
| `references/branch-management.md` | đặt tên, vòng đời nhánh |
| `references/gh-cli-guide.md` | lệnh `gh` |

## Ranh giới

- Không có subagent nào để đẩy output dài sang. Output git dài thì lọc bằng `--stat`,
  `--oneline`, `-n`, đừng đổ nguyên vào context.
- Không push lên `main`/`master`, không force-push, không merge — trừ khi principal nói
  thẳng, trong phiên này.
