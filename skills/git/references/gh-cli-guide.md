# Hướng dẫn `gh`

Lệnh `gh` chia làm hai loại. Đọc bảng này trước khi chạy bất cứ lệnh nào bên dưới.

| Loại | Lệnh | Quy tắc |
|---|---|---|
| **Đọc** | `list`, `view`, `diff`, `status`, `browse` | chạy tự do |
| **Tác động ra ngoài** | `create`, `merge`, `comment`, `close`, `rerun`, `auth` | **hỏi principal từng lần** (HOUSE-RULES §1.2) |

## Xác thực

```bash
gh auth status       # kiểm trạng thái — đọc, chạy được
gh auth login        # tương tác — KHÔNG tự chạy, báo principal
gh auth logout       # KHÔNG tự chạy
```

Chưa đăng nhập thì báo principal chạy `gh auth login` — nó cần tương tác, agent chạy sẽ treo.

## Pull Request

### Tạo — cần duyệt

```bash
gh pr create --base main --head <nhánh> --title "feat: …" --body "…"
```

Thân dài dùng heredoc:

```bash
gh pr create --base main --title "feat(acl): …" --body "$(cat <<'EOF'
## Tóm tắt
- …

## Kiểm chứng
- [ ] …
EOF
)"
```

```bash
gh pr create --draft --title "WIP: …"        # nháp — rẻ hơn mở PR thật rồi phải đóng
gh pr create --reviewer @user1,@user2
gh pr create --label "bug,priority:high"
```

Việc chưa xong hẳn thì mở **draft**. Xem `workflow-pr.md`.

### Đọc — chạy tự do

```bash
gh pr list
gh pr view 123
gh pr view 123 --web
gh pr checkout 123          # đổi nhánh làm việc — báo principal trước
gh pr diff 123
gh pr status
```

### Merge — cần duyệt

```bash
gh pr merge 123               # merge commit
gh pr merge 123 --squash
gh pr merge 123 --rebase
gh pr merge 123 --auto        # tự merge khi check xanh
gh pr merge 123 --delete-branch
```

**`--auto` đặc biệt nguy hiểm với agent:** nó merge *sau này*, không phải bây giờ. Chạy
xong rồi mà principal đổi ý thì merge vẫn xảy ra. Không dùng trừ khi principal nói thẳng.

### Bình luận — cần duyệt

```bash
gh pr comment 123 --body "…"                     # ra ngoài, người khác thấy
gh api repos/{owner}/{repo}/pulls/123/comments   # đọc, tự do
```

## Issue

```bash
gh issue list                                    # đọc
gh issue view 42                                 # đọc
gh issue create --title "…" --body "…"           # cần duyệt
gh issue develop 42 -c                           # tạo nhánh từ issue — cần duyệt
```

## Repo

```bash
gh repo view
gh browse
gh browse path/to/file:42     # mở file đúng dòng
gh repo clone owner/repo      # tải về máy — báo principal
```

## Workflow

```bash
gh run list                   # đọc
gh run view <run-id>          # đọc
gh run watch                  # đọc, nhưng CHẶN cho tới khi workflow xong — cân nhắc
gh run rerun <run-id>         # tốn tài nguyên CI — cần duyệt
```

Đọc log CI hỏng: xem `alp-debug` nếu vai đó được giao, hoặc `gh run view <id> --log-failed`.

## Xuất JSON — để lọc, không để đọc

```bash
gh pr list --json number,title,author
gh pr view 123 --json commits,reviews
gh issue list --json number,title --jq '.[].title'
```

Dùng `--json` + `--jq` để **cắt output trước khi nó vào context**. Không có subagent để
đẩy output dài sang, nên lọc là việc của bạn.

## Mẫu KHÔNG dùng

```bash
# ❌ tạo PR rồi tự merge — hai thao tác cần duyệt, gộp thành một dòng
gh pr create --fill && gh pr merge --auto --squash

# ❌ đóng hàng loạt PR
gh pr list --state open --json number -q '.[].number' | xargs -I {} gh pr close {}
```

Hai mẫu này có trong bản gốc của skill. Chúng vi phạm HOUSE-RULES §1.2 — thao tác khó đảo
ngược, hàng loạt, không có bước dừng để principal xem. Cần làm thì làm từng cái, mỗi cái
một lần duyệt.
