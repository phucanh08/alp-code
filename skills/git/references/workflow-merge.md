# Quy trình merge

**Merge vào nhánh chính là hành động khó đảo ngược.** Phải được principal nói thẳng trong
phiên này. Không tự merge, kể cả khi thấy "rõ ràng là xong rồi".

Biến: `TO` = nhánh đích (mặc định `main`) · `FROM` = nhánh nguồn (mặc định nhánh hiện tại).

## 1. Đồng bộ với remote

```bash
git fetch origin
git checkout {TO}
git pull origin {TO}
```

## 2. Thử khô trước

```bash
git merge --no-commit --no-ff origin/{FROM}
git merge --abort
```

Biết trước có xung đột hay không **trước khi** bắt đầu merge thật. Đây là bước rẻ nhất
trong cả quy trình và là bước hay bị bỏ nhất.

## 3. Merge

```bash
git merge origin/{FROM} --no-ff -m "merge: {FROM} vào {TO}"
```

**Vì sao `origin/{FROM}` chứ không phải `{FROM}`:** để chắc chỉ merge thứ đã commit *và* đã
push. Merge nhánh local có thể kéo theo WIP chưa ai thấy.

## 4. Xung đột

Có xung đột → **báo principal, không tự chọn bên**. Chọn sai bên trong một merge là mất
code mà `git diff` sau đó không cho thấy.

Principal quyết rồi thì:

```bash
git add <file đã giải quyết> && git commit
```

Không dùng `git add .` sau khi giải quyết xung đột — nó nuốt luôn file khác đang dở.

## 5. Push

Xem `workflow-push.md`. Vẫn cần duyệt riêng — duyệt merge không phải duyệt push.

## Xử lý lỗi

| Lỗi | Làm gì |
|---|---|
| xung đột | báo principal, không tự chọn bên |
| không tìm thấy nhánh | kiểm tên, chắc là đã push lên remote chưa |
| push bị từ chối | `git pull --rebase` — hỏi trước |

## Worktree

alp-code dùng worktree. Merge trong một worktree vẫn ảnh hưởng repo chung — nhánh là dùng
chung, chỉ có working tree là riêng. Đừng nghĩ mình đang ở chỗ cô lập nên merge nào cũng an toàn.
