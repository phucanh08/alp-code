# Quy trình mở Pull Request

Mở PR là **đưa việc ra ngoài** — cần principal duyệt như push (HOUSE-RULES §1.2).

Biến: `BASE` = nhánh đích (mặc định `main`) · `HEAD` = nhánh nguồn (mặc định nhánh hiện tại).

## Luật lõi: so bằng diff REMOTE

PR dựng trên nhánh **trên remote**. Diff local có cả thứ chưa push, nên mô tả PR viết theo
diff local sẽ kể những thay đổi mà người review không nhìn thấy.

**Không dùng để soạn nội dung PR:** `git diff main...HEAD` · `git diff --cached` ·
`git status`. Ba lệnh này đều so với working tree local.

## 1. Đồng bộ và phân tích

```bash
git fetch origin && \
BASE=${BASE:-main} && \
HEAD=$(git rev-parse --abbrev-ref HEAD) && \
echo "=== PR: $HEAD → $BASE ===" && \
echo "=== COMMIT ===" && \
git log origin/$BASE...origin/$HEAD --oneline && \
echo "=== FILE ===" && \
git diff origin/$BASE...origin/$HEAD --stat
```

Báo "nhánh chưa có trên remote" → push trước (cần duyệt), rồi chạy lại.

Diff rỗng → dừng, báo principal "không có thay đổi nào để mở PR". Đừng mở PR rỗng.

## 2. Soạn nội dung

**Tiêu đề:** conventional commit, dưới 72 ký tự, tiếng Việt cho phần mô tả, **không** kèm
số phiên bản.

**Thân:** tóm tắt gạch đầu dòng + checklist kiểm chứng. Trả lời *vì sao*, không phải *làm
gì* — diff đã nói làm gì.

## 3. Tạo PR

```bash
gh pr create --base "$BASE" --head "$HEAD" --title "…" --body "$(cat <<'EOF'
## Tóm tắt
- …

## Kiểm chứng
- [ ] …

## Câu hỏi còn mở
- …
EOF
)"
```

Mở **draft PR** (`--draft`) khi việc chưa xong hẳn — rẻ hơn nhiều so với mở PR thật rồi
phải đóng.

## Xử lý lỗi

| Lỗi | Làm gì |
|---|---|
| nhánh chưa có trên remote | push trước (xin duyệt), rồi chạy lại |
| diff rỗng | dừng, báo principal |
| push bị từ chối | `git pull --rebase` — hỏi trước |
| `gh` chưa đăng nhập | `gh auth status`; báo principal, đừng tự đăng nhập |

## Sau khi tạo

Báo principal **URL của PR**. Không tự merge PR vừa mở — xem `workflow-merge.md`.
