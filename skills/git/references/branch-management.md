# Quản lý nhánh

## Đặt tên

**Dạng:** `<type>/<mô-tả-kebab>`

| Type | Dùng cho | Ví dụ |
|---|---|---|
| `feature/` | tính năng mới | `feature/oauth-login` |
| `fix/` | sửa lỗi | `fix/session-repo-root` |
| `refactor/` | đổi cấu trúc | `refactor/api-cleanup` |
| `docs/` | tài liệu | `docs/api-reference` |
| `test/` | test | `test/integration-suite` |
| `chore/` | bảo trì | `chore/deps-update` |
| `hotfix/` | sửa gấp trên production | `hotfix/payment-crash` |

Xem `git branch -a` trước khi đặt tên mới — theo mẫu đang có, đừng tự nghĩ dạng mới.

## Vòng đời

### Tạo

```bash
git checkout main
git pull origin main
git checkout -b feature/ten-nhanh
```

Luôn tạo từ `main` **đã pull mới**. Tạo từ một nhánh cũ thì diff sẽ dính cả thay đổi của
người khác, và PR sau đó không đọc được.

### Trong lúc làm

```bash
git add <file> && git commit -m "type(scope): mô tả"

git fetch origin
git rebase origin/main      # HỎI TRƯỚC — rebase viết lại commit của bạn
```

### Trước khi merge

```bash
git push origin feature/ten-nhanh
```

Sau rebase thì phải force — **chỉ trên nhánh feature của mình**, và dùng
`--force-with-lease`:

```bash
git push --force-with-lease origin feature/ten-nhanh
```

### Sau khi merge

```bash
git branch -d feature/ten-nhanh                    # xoá local (an toàn: -d từ chối nếu chưa merge)
git push origin --delete feature/ten-nhanh         # xoá remote — HỎI TRƯỚC
```

Dùng `-d`, **không** dùng `-D`. `-d` từ chối xoá nhánh chưa merge; `-D` xoá bất chấp và đó
là cách mất việc.

## Worktree trong alp-code

Repo này dùng worktree cho nhánh triển khai cô lập (`.worktrees/` đã trong `.gitignore`).

Điều dễ nhầm: **nhánh là dùng chung giữa mọi worktree, chỉ working tree là riêng.** Một
nhánh đang được checkout ở worktree khác thì không checkout lại được ở đây — đó là tính
năng, không phải lỗi.

Stash stack cũng dùng chung. Xem phần cuối `safety-protocols.md`.

## Nhánh trong alp-code

`main` là nhánh chính. **Không push thẳng lên `main`** — làm trên nhánh, mở PR, principal
quyết định merge.

## Lệnh nhanh

| Việc | Lệnh |
|---|---|
| liệt kê nhánh | `git branch -a` |
| nhánh hiện tại | `git rev-parse --abbrev-ref HEAD` |
| chuyển nhánh | `git checkout <nhánh>` |
| tạo và chuyển | `git checkout -b <nhánh>` |
| xoá local | `git branch -d <nhánh>` |
| xoá remote | `git push origin --delete <nhánh>` |
| đổi tên | `git branch -m <cũ> <mới>` |
| liệt kê worktree | `git worktree list` |
