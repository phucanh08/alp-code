# Luật an toàn git

## Quét secret

```bash
git diff --cached | grep -iE '(AKIA|api[_-]?key|token|password|secret|credential|private[_-]?key|mongodb://|postgres://|mysql://|redis://|-----BEGIN)'
```

| Nhóm | Mẫu | Ví dụ |
|---|---|---|
| API key | `api[_-]?key`, `apiKey` | `API_KEY=abc123` |
| AWS | `AKIA[0-9A-Z]{16}` | `AKIAIOSFODNN7EXAMPLE` |
| Token | `token`, `auth_token`, `jwt` | `AUTH_TOKEN=xyz` |
| Mật khẩu | `password`, `passwd`, `pwd` | `DB_PASSWORD=…` |
| Private key | `-----BEGIN PRIVATE KEY-----` | file PEM |
| Chuỗi kết nối DB | `mongodb://`, `postgres://`, `mysql://` | có kèm credential |
| OAuth | `client_secret`, `oauth_token` | `CLIENT_SECRET=…` |

**File luôn phải cảnh báo:** `.env`, `.env.*` (trừ `.env.example`) · `*.key`, `*.pem`,
`*.p12` · `credentials.json`, `secrets.json` · `config/private.*`

### Khi phát hiện

1. **Chặn commit ngay.**
2. In dòng khớp: `git diff --cached | grep -B2 -A2 <mẫu>`
3. Báo principal: thêm vào `.gitignore` hay chuyển sang biến môi trường.
4. Đề xuất bỏ stage: `git reset HEAD <file>` — **hỏi trước khi chạy**.
5. Nếu secret **đã từng được commit** thì xoá file là chưa đủ: nó nằm trong lịch sử. Nói
   thẳng điều đó và khuyến nghị xoay khoá.

## Hai đường dẫn không bao giờ được commit — riêng của alp-code

| Đường dẫn | Vì sao |
|---|---|
| `memory/**` | trí nhớ là dữ liệu cục bộ từng máy. Đẩy lên remote là rò dữ liệu của principal |
| `identity/*/.claude/**` | `settings.json`, `.acl-stamp`, `skills/` đều do `compile-acl` sinh, chứa path tuyệt đối của máy này |

Thấy chúng trong `git diff --cached` nghĩa là `.gitignore` hỏng. Báo principal, không tự
`git rm` — xoá nhầm `memory/` là mất thật, không khôi phục từ remote được.

## Bảo vệ nhánh

**Không bao giờ force push lên:** `main`, `master`, `production`, `prod`, `release/*`.

Force push trên nhánh feature: chỉ khi principal nói thẳng, và dùng `--force-with-lease`
chứ không phải `-f`. `--force-with-lease` từ chối ghi đè khi remote có commit bạn chưa thấy.

## So bằng remote, không so bằng local

```
✅ git diff origin/main...origin/feature
❌ git diff main...HEAD          # dính cả thay đổi local chưa push
```

Trước khi merge, thử khô:

```bash
git merge --no-commit --no-ff origin/<nhánh> && git merge --abort
```

## Khôi phục

| Việc | Lệnh | Mức nguy hiểm |
|---|---|---|
| bỏ commit cuối, giữ thay đổi đã stage | `git reset --soft HEAD~1` | an toàn |
| bỏ commit cuối, giữ thay đổi chưa stage | `git reset HEAD~1` | an toàn |
| huỷ merge đang dở | `git merge --abort` | an toàn |
| bỏ thay đổi một file | `git checkout -- <file>` | **mất việc chưa lưu** |
| bỏ toàn bộ thay đổi | `git reset --hard HEAD` | **mất việc chưa lưu** |

Hai dòng cuối là **khó đảo ngược**: phải hỏi principal từng lần (HOUSE-RULES §1.2).
`git reset --soft HEAD~1` chỉ áp dụng cho commit **chưa push** — đã push rồi thì việc sửa
lịch sử ảnh hưởng người khác, hỏi trước.

## Stash trong worktree

alp-code dùng worktree, và **stash stack là dùng chung giữa mọi worktree**. `git stash pop`
trần có thể lấy nhầm việc của phiên khác đang chạy song song.

Cần cất việc tạm → tạo commit WIP. Buộc phải stash thì đặt tên và lấy lại theo SHA:

```bash
git stash push -u -m "<nhãn riêng>"
git stash list --format='%H %gs'      # lấy SHA của đúng entry mình vừa tạo
git stash apply <sha>                 # apply, KHÔNG pop
```
