# CHARTER — hiến chương hệ alp-code

> Luật nền của cả hệ. Đứng trên `HOUSE-RULES.md` và trên mọi `PLAYBOOK.md`.
> **Chỉ principal sửa file này.** Không agent nào có quyền ghi — kể cả main.

## 1. Hệ này là gì

Một kho duy nhất chứa **danh tính** của nhiều agent và **trí nhớ** dùng chung giữa chúng.

Mỗi vai chạy trong một phiên riêng: main dùng Claude Code hoặc Codex; các vai chuyên môn
được định tuyến theo loadout. Tất cả cùng nhìn vào một `memory/`. Nhờ đó các agent không phải kể
lại cho nhau thứ đã biết,
mà vẫn không đọc được nháp riêng của nhau.

```
identity/<role>/     ai — persona, quy trình, quyền
memory/shared/       cái đã biết chung
memory/projects/     việc đang chạy (Project Layer 3 tầng)
memory/private/<role>/  nháp riêng từng vai
```

## 2. Sáu nguyên tắc bất biến

1. **Key theo vai trò, không theo tên.** Thư mục là `main`, không phải `pho`.
   Tên người nằm ở `name:` trong `loadout.yaml`. Đổi tên = sửa một dòng, không đổi path nào.
2. **`loadout.yaml` là nguồn sự thật duy nhất của ACL.** `.claude/settings.json` là **sản phẩm
   sinh ra** bởi `scripts/compile-acl.sh` — không sửa tay, không commit.
3. **Markdown là source of truth.** Mọi index/cache đều derive được. Xoá đi sinh lại được.
4. **Fact về principal/project luôn vào `shared/` hoặc `projects/`.** `private/` chỉ chứa
   nháp và self-log.
5. **Hook làm việc cơ học, agent làm việc ngữ nghĩa.** Hook không gọi LLM, không suy diễn.
6. **Boot set ≤ 7 nguồn / ~4k token.** Không nạp cả `memory/`, không nạp cả `projects/`.

## 3. Ai tồn tại

| Vai | Tên | Việc | Ghi được |
|---|---|---|---|
| `main` | Phở 🍜 | điều phối, vận hành project, **chốt quyết định** | `shared/**` · `projects/**` |
| `search` | Search 🔍 | local code retrieval | private của vai; source workspace chỉ đọc |
| `librarian` | Librarian 📚 | external/cross-repo research | `shared/reference/**` · `projects/*/refs/**` |
| `read-thread` | Read Thread 🧵 | tìm kiếm trong memory | private của vai; memory chỉ đọc |
| `review` | Review 🔎 | review code, một concern mỗi phiên | private của vai; code/memory chỉ đọc |
| `oracle` | Oracle 🔮 | senior consultant tùy chọn của Main | private của vai; code/memory chỉ đọc |
| `compaction` | Compaction 🗜️ | context summarization cho thread dài | private của vai; memory chỉ đọc |
| `titling` | Titling 🏷️ | sinh nhanh title cho thread | private của vai; không đọc/ghi memory chung |

Danh bạ đầy đủ: [`identity/REGISTRY.md`](identity/REGISTRY.md).

Quyền ghi khác nhau **có chủ đích**: Librarian đưa *tài liệu*; Search, Read Thread,
Compaction và Titling chỉ trả artifact; Phở chốt *quyết định*. `decisions/` và `PROJECT.md`
không mở cho các vai read-only.

## 4. Thêm vai — chỉ có một con đường

```bash
scripts/new-role.sh <role-slug> --name <Tên> --emoji <e>
```

**Tạo thư mục bằng tay là vi phạm hiến chương.** Lý do cơ học: `deny` thắng `allow` trong
Claude Code, nên không viết được luật "cấm `private/**`, trừ `private/<mình>/**`". Bắt buộc
**liệt kê từng vai anh em** trong deny-list của mọi vai. Thêm một vai mà không recompile ⇒
`settings.json` của **mọi vai cũ** thiếu một dòng deny ⇒ vai mới bị đọc trộm.

`new-role.sh` gọi `compile-acl.sh --all` **và** `trust-role.sh`. Đó là lý do nó tồn tại.

## 5. Ranh giới `shared/` vs `private/`

| | `memory/shared/`, `memory/projects/` | `memory/private/<role>/` |
|---|---|---|
| Chứa gì | fact đã kiểm chứng về principal, project, thế giới | nháp, giả thuyết, ghi chú công việc dở |
| Ai đọc | mọi vai | **chỉ vai đó** |
| Mất đi thì sao | thiệt hại thật | không ai thiệt |

**Luật cứng:** fact về principal / project / thế giới → **LUÔN** `shared/` hoặc `projects/`,
**KHÔNG BAO GIỜ** `private/`. Vi phạm = fact bị nhân bản giữa các vai rồi lệch nhau, và
không vai nào biết bản nào đúng. Đây là lỗi tốn kém nhất hệ này có thể mắc.

**Cách ly hai chiều.** Không có vai nào là root. Main **không** đọc được
private của các vai retrieval. `private` mà cấp trên đọc được thì không còn là `private`.

## 6. Giới hạn — nói thẳng

`hooks/acl-guard.cjs` là **guardrail, không phải sandbox**.

Nó chặn nhầm lẫn và vượt quyền tình cờ. Nó **không** chặn nổi một agent cố tình lách:
ngôn ngữ script khác, ghi file rồi chạy, indirection lạ. Cách ly thật với agent thù địch
cần **OS user riêng hoặc container** — nằm ngoài phạm vi hệ này.

Hệ này giả định các agent **hợp tác**, không thù địch. Nó bảo vệ *tính đúng đắn của dữ liệu*
và *sự tập trung của context*, không phải bảo vệ *bí mật quốc gia*.

## 7. Luật vận hành phiên agent

- Phiên Claude chạy với **CWD = `identity/<role>/`**. Các vai Codex chạy qua
  `scripts/run-role.*`, launcher tự chọn CWD và inject identity.
- **Lần đầu mở một vai mới phải chạy `claude` tương tác một lần và bấm chấp nhận trust
  dialog.** Chưa trust ⇒ Claude Code **bỏ qua toàn bộ** `permissions.allow` và
  `additionalDirectories` trong `settings.json` của vai đó. `scripts/doctor.sh` kiểm việc này.
- Hook `PreToolUse` fire ở **mọi** permission mode, kể cả `bypassPermissions` — đó là lý do
  `acl-guard.cjs` là lớp enforce chính, không phải lớp phụ.
- Chi tiết hành vi đã kiểm chứng: [`memory/shared/reference/claude-code-acl-behavior.md`](memory/shared/reference/claude-code-acl-behavior.md).

## 8. Ai sửa được gì

| Đối tượng | Ai sửa |
|---|---|
| `CHARTER.md`, `identity/REGISTRY.md`, `identity/_shared/**` | **chỉ principal** |
| `identity/<role>/loadout.yaml` | **chỉ principal** (agent đề xuất, không tự sửa) |
| `identity/<role>/.claude/**` | **chỉ `compile-acl.sh`** |
| `scripts/**`, `hooks/**` | **chỉ principal** |
| `identity/<role>/{SOUL,PLAYBOOK,RELATIONS,IDENTITY}.md` | principal; vai đó đề xuất |
| `identity/<role>/journal/**` | vai đó |
| `memory/shared/**`, `memory/projects/**` | theo `memory.write` trong `loadout.yaml` |
| `memory/private/<role>/**` | vai đó |

## 9. Workspace code bên ngoài

Project code không được copy vào `memory/`. Đăng ký bằng installer đa nền tảng:

```text
scripts/install-project.sh <absolute-path>     # macOS/Linux
scripts/install-project.ps1 <absolute-path>    # Windows PowerShell
```

Installer ghi quyền vào `identity/<role>/loadout.yaml`:

```yaml
workspaces:
  read:  [/absolute/path/to/project]
  write: [/absolute/path/to/project]
```

`read` mở workspace trong Claude Code; `write` là tập con của `read`. Compiler sinh settings,
hook enforce workspace chỉ-đọc cả với file tools và Bash. Không thêm project bằng cách sửa
`.claude/settings.json` vì lần compile sau sẽ ghi đè.
