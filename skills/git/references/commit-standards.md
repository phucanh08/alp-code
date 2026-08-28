# Chuẩn commit message

## Dạng

```
type(scope): mô tả
```

Mô tả viết **tiếng Việt** — khớp lịch sử repo. Xem `git log --oneline -20` trước khi viết
cái đầu tiên.

## Type

| Type | Dùng khi |
|---|---|
| `feat` | tính năng mới |
| `fix` | sửa lỗi |
| `refactor` | đổi cấu trúc, không đổi hành vi |
| `docs` | chỉ tài liệu |
| `test` | test |
| `chore` | bảo trì, deps, config |
| `perf` | hiệu năng |
| `style` | định dạng, không đổi logic |
| `ci` | CI/CD |

## Scope trong alp-code

Lấy theo vùng thật của repo, không tự đặt mới:

`agents` · `delegation` · `runtime` · `hooks` · `installer` · `skills` · `scripts` · `memory`

Scope là tuỳ chọn. Thay đổi trải rộng nhiều vùng thì bỏ scope, đừng liệt kê ba scope một lúc.

## Luật

- **Dòng đầu ≈72 ký tự.** Rõ quan trọng hơn ngắn — thà 76 ký tự mà đọc hiểu ngay.
- Không có dấu chấm cuối dòng đầu.
- Dòng đầu nói **cái gì**. Thân commit nói **vì sao**.
- `git diff` đã kể *làm gì*, nên thân commit đừng kể lại. Nó tồn tại để trả lời câu hỏi
  người đọc `git log` sáu tháng sau sẽ hỏi: *tại sao lại làm thế này?*
- Có issue liên quan thì dẫn số.

## Thân commit

Thay đổi không hiển nhiên thì **phải** có thân. Mẫu theo repo:

```
fix: repoRoot của phiên + workspaces không còn path tuyệt đối

<vì sao cách cũ hỏng — mô tả triệu chứng thật, không mô tả code>

- <thay đổi 1 — và vì sao chọn cách này>
- <thay đổi 2>
```

## Attribution

Repo này **có** dùng trailer attribution — 5/8 commit gần nhất có. Giữ nguyên thói quen đó:

```
Co-Authored-By: <model> <noreply@anthropic.com>
```

Đây là khác biệt so với bản gốc của skill (cấm attribution). alp-code làm ngược lại, và
lịch sử repo là nguồn sự thật, không phải tài liệu skill.

## Ví dụ đúng

```
feat(agents): register alp-plugin workspace
fix(runtime): resolve claude/codex command via PATHEXT
docs: báo cáo chẩn đoán repoRoot + gitignore session-state ở gốc repo
```

## Ví dụ sai

| Sai | Vì sao |
|---|---|
| `Updated files` | không nói gì |
| `Fix bug` | bug nào? |
| `feat(auth): thêm login dùng bcrypt với salt 12 vòng` | kể *làm thế nào*, thuộc về thân commit |
| `feat(acl,hooks,skills): …` | ba scope một lúc — tách commit ra |
