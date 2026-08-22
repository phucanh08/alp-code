# Quy trình push

**Push là hành động khó đảo ngược** — ra khỏi máy, người khác thấy ngay. Phải được
principal duyệt **trong phiên này** (HOUSE-RULES §1.2). Không có "lần trước đã duyệt rồi".

## 1. Kiểm tra trạng thái

```bash
git status && \
git log origin/$(git rev-parse --abbrev-ref HEAD)..HEAD --oneline 2>/dev/null || echo "CHƯA_CÓ_UPSTREAM"
```

- Còn thay đổi chưa commit → báo principal, đề xuất commit trước.
- `CHƯA_CÓ_UPSTREAM` → dùng `git push -u origin HEAD`.

Đọc danh sách commit sắp push **trước khi push**. Push nhầm một commit chứa `memory/` là
đẩy dữ liệu cục bộ của principal lên remote.

## 2. Push

```bash
git push origin HEAD
```

**Không push lên `main`/`master`.** Nhánh chính chỉ principal đụng.

## Xử lý lỗi

| Lỗi | Nguyên nhân | Làm gì |
|---|---|---|
| `rejected - non-fast-forward` | remote có commit mới hơn | đề xuất `git pull --rebase` — **hỏi trước khi chạy**, rebase viết lại commit của bạn |
| `no upstream branch` | nhánh chưa track | `git push -u origin HEAD` |
| `Authentication failed` | sai credential | kiểm `gh auth status` hoặc SSH key — báo principal, đừng tự đổi cấu hình auth |
| `Repository not found` | sai remote | kiểm `git remote -v` |
| `Permission denied` | không có quyền ghi | báo principal |

## Force push

**Không bao giờ force push lên `main`/`master`/nhánh production.** Không có ngoại lệ.

Trên nhánh feature, chỉ khi principal nói thẳng:

```bash
git push --force-with-lease origin HEAD
```

Dùng `--force-with-lease`, **không** dùng `-f` trần: `--force-with-lease` từ chối ghi đè
nếu remote có commit bạn chưa thấy. `-f` thì ghi đè bất chấp — đó là cách xoá việc của
người khác mà không ai biết.

Cảnh báo principal trước: force push viết lại lịch sử, ai đang làm trên nhánh đó có thể mất
việc.

## Báo cáo

```
✓ pushed: N commit → origin/<nhánh>
  - abc123 feat(acl): …
  - def456 fix(hooks): …
```

Không push thì nói rõ chưa push và vì sao.
