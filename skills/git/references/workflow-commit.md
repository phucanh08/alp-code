# Quy trình commit

Tự chạy. Không có subagent nào để đẩy output sang.

## 1. Stage và phân nhóm

```bash
git add -A && \
echo "=== ĐÃ STAGE ===" && git diff --cached --stat && \
echo "=== SECRET ===" && \
git diff --cached | grep -c -iE '(api[_-]?key|token|password|secret|credential)' | awk '{print "SECRET:"$1}' && \
echo "=== NHÓM ===" && \
git diff --cached --name-only | awk -F'/' '{
  if ($0 ~ /^memory\//) print "CẤM:"$0
  else if ($0 ~ /^identity\/[^\/]+\/\.claude\//) print "CẤM:"$0
  else if ($0 ~ /\.(md|txt)$/) print "docs:"$0
  else if ($0 ~ /test|spec/) print "test:"$0
  else if ($0 ~ /^(scripts|hooks)\//) print "code:"$0
  else if ($0 ~ /package\.json|lock/) print "deps:"$0
  else print "code:"$0
}'
```

**SECRET > 0** → DỪNG, in các dòng khớp, chặn commit, báo principal.

**Có dòng `CẤM:`** → `.gitignore` đang hỏng. Hai thứ này không bao giờ được vào commit:

| Đường dẫn | Vì sao |
|---|---|
| `memory/**` | trí nhớ là dữ liệu cục bộ từng máy, không đi theo git |
| `~/.alp/executions/**` | sản phẩm của `npm run build`, chứa path tuyệt đối của máy này |

Báo principal. **Không tự `git rm`** — xoá nhầm trí nhớ là mất thật.

## 2. Quyết định tách

**Một commit:** cùng type và scope, ≤ 3 file, ≤ 50 dòng.

**Nhiều commit:** trộn type/scope → tách theo nhóm, commit theo thứ tự này:

| Thứ tự | Nhóm | Prefix |
|---|---|---|
| 1 | deps | `chore(deps): …` |
| 2 | code | `feat|fix|refactor(scope): …` |
| 3 | test | `test: …` |
| 4 | docs | `docs: …` |

Deps trước code vì code có thể phụ thuộc deps mới — commit ngược thứ tự thì có một commit
ở giữa không build được.

Scope trong alp-code lấy theo vùng thật: `acl`, `herdr`, `installer`, `hooks`, `skills`,
`identity`. Xem `git log --oneline -20` để theo scope đã dùng, đừng tự đặt scope mới.

## 3. Commit

Một commit:

```bash
git commit -m "type(scope): mô tả"
```

Nhiều commit — làm tuần tự, mỗi nhóm một lần:

```bash
git reset && git add <file…> && git commit -m "type(scope): mô tả"
```

`git reset` ở đây chỉ bỏ stage, **không** đụng working tree. Đừng nhầm với
`git reset --hard`.

## 4. Push

```bash
git push
```

**Chỉ push khi principal nói thẳng trong phiên này** — "push", "commit rồi push".
Được duyệt lần trước không tính cho lần này (HOUSE-RULES §1.2).

Không push lên `main`/`master`. Không `--force`.

## Báo cáo

```
✓ staged: N file (+X/−Y dòng)
✓ secret: sạch
✓ commit: <hash> type(scope): mô tả
✗ push: CHƯA — chờ principal duyệt
```
