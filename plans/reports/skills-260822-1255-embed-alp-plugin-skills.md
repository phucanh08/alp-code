# Nhúng skill alp-plugin vào alp-code

Nhánh `worktree-embed-alp-skills` (trên `fix/session-repo-root-and-portable-workspaces`) · commit `1168350`

## Đã làm

Nhúng 13 skill từ `phucanh08/alp-plugin@master` (commit `107d219`) vào `skills/`, lọc theo
nhu cầu thật của 8 vai. 552KB, không binary, không node_modules, không secret.

Nhưng phát hiện chính không phải chuyện chép file: **`skills/` ở gốc repo không runtime nào
tự thấy.** Claude Code chỉ nạp skill từ `<cwd>/.claude/skills/`, mà CWD của phiên là
`identity/<role>/` (CHARTER §7). Trước commit này `skills:` trong loadout chỉ là một dòng
chữ in ra trong thẻ danh tính — kể cả `agent-memory` và `herdr` cũng chưa từng được nạp thật.
Nên phần lớn công việc là wiring.

## Mapping skill → vai

| Vai | Trước | Sau | Vì sao |
|---|---|---|---|
| main | `agent-memory, herdr, alp:plan, alp:cook` | `agent-memory, herdr, alp-plan, git` | `alp:cook` bắt spawn subagent qua Task tool, main không có `Task` trong `tools:` |
| search | `agent-memory, alp:scout` | `agent-memory, gkg` | `scout` cũng cần Task; `gkg` (go-to-definition, find-usages) đúng bước 3–4 PLAYBOOK |
| librarian | `agent-memory, alp:research, alp:docs-seeker` | `agent-memory, research, docs-seeker` | mapping đã đúng, chỉ bỏ tiền tố |
| read-thread | `agent-memory` | giữ nguyên | không có Bash → skill chạy script sẽ fail |
| review | `agent-memory` | `+code-review, alp-scenario, security-scan` | PLAYBOOK chia 4 concern nhưng trước đó không có skill nào |
| oracle | `agent-memory` | `+alp-predict, problem-solving, alp-debug` | `alp-predict` = 5 persona tranh luận, khớp "phản biện độc lập trước quyết định rủi ro cao" |
| compaction | `[]` | giữ `[]` | rà cả 81 skill: không skill nào nén thread |
| titling | `[]` | giữ `[]` | `tools: []`, không skill nào chạy được |

`scout` và `repomix` có nhúng nhưng chưa gán vai nào — để sẵn, không bật.

## Thay đổi code

| File | Việc |
|---|---|
| `scripts/lib/skill-links.cjs` (mới) | loadout `skills:` → symlink `identity/<role>/.claude/skills/<tên>`. Link **từng skill**, không link cả thư mục → vai chỉ thấy skill trong loadout của mình. Target tương đối (`../../../../skills/<tên>`) để không chết khi clone sang máy/đường dẫn khác |
| `scripts/compile-acl.cjs` | sinh + dọn link cùng lúc với `settings.json`; `--check` báo `SKILL-DRIFT` |
| `scripts/lib/loadout.cjs` | `validate()` nhận `knownSkills` (tham số 4, optional) — tên skill không có thật và tên trùng giờ là lỗi |
| `scripts/lib/claude-settings.cjs` | truyền `knownSkills` vào validate → compile fail đóng khi loadout khai skill ma |
| `scripts/doctor.cjs` | tín hiệu `SKILL-DRIFT` |
| `identity/_shared/HOUSE-RULES.md` | §5 mới: skill ở đâu, Claude tự nạp / Codex đọc `.claude/skills/<tên>/SKILL.md` khi cần |
| `.gitignore` | `identity/*/.claude/skills/` — sản phẩm sinh ra, cùng loại `settings.json` |
| `scripts/test-skill-links.cjs` (mới) | 18 ca |

Hệ quả phụ đáng giá: **`skills:` giờ là ACL thật**, cùng hạng với `tools:` và `memory:`,
không còn là dòng trang trí.

## Sửa khi nhúng

- Frontmatter `name:` của 6 skill không hợp lệ ngoài ngữ cảnh plugin — `alp:debug`,
  `alp:plan`, `alp:scenario`, `alp:predict`, `alp:security-scan` (ký tự `:` là reserved),
  và `Problem-Solving Techniques` (có dấu cách) → chuẩn hoá về tên thư mục.
- Tham chiếu chéo `alp:X` trong 14 file → tên local.
- Bỏ 6 thư mục lồng `skills/X/X/` (bản slash-command trùng nội dung, sinh ra từ commit
  `c9c4df3` của alp-plugin; alp-code không có hệ command).

Đính chính báo cáo trước: `alp:plan` trong loadout của main **không phải** lỗi gõ sai — nó
khớp frontmatter `name: alp:plan` của thư mục `alp-plan`. Vẫn phải đổi, vì tên có `:` không
dùng được cho skill repo-local.

## Kiểm chứng

`compile-acl --check` OK · `doctor` sạch · 8/8 test chạy được đều xanh
(skill-links 18 ca, loadout-models, agent-routing, communication, delegation, cli-link,
project-config, codex-role). Thử phá: xoá một link → doctor báo `SKILL-DRIFT` → compile
sinh lại → sạch.

Hai test không chạy được trong worktree, **cả hai đều là hạn chế môi trường có sẵn, không
phải hồi quy**:

- `test-codex-profile.cjs` — assert `!/claude/.test(toml)` mà đường dẫn worktree chứa
  `.claude/worktrees/`. Chạy từ checkout chính: xanh. Assertion này cũng sẽ fail với bất kỳ
  ai clone repo vào đường dẫn có chữ "claude".
- `test-isolation.cjs` — cần một project đã đăng ký trong `memory/projects/`.

## Chưa làm — cần bạn quyết

1. **Vai Codex vẫn chưa có hệ skill thật.** Codex chỉ nạp skill từ plugin cài qua
   marketplace (`codex plugin marketplace add` → `codex plugin add`); máy bạn hiện chưa cấu
   hình marketplace nào. HOUSE-RULES §5 xử lý bằng cách bảo vai Codex tự đọc `SKILL.md` —
   chạy được nhưng là đọc file, không phải skill system. Muốn đúng chuẩn thì alp-code phải
   tự thành Codex plugin (`.codex-plugin/plugin.json` + marketplace cục bộ).
2. **23 tham chiếu treo** tới 7 skill chưa nhúng: `alp:cook` (12, hầu hết trong `alp-plan`
   ở bước bàn giao sang implement), `alp:chrome-devtools` (5), `alp:journal` (2), `alp:test`,
   `alp:sequential-thinking`, `alp:project-organization`, `alp:mcp-management`. Đều là bước
   tuỳ chọn và `alp-debug` đã có fallback tử tế. Nhúng thêm hay sửa văn bản?
3. **`Skill` vẫn không nằm trong `KNOWN_TOOLS`** (`lib/loadout.cjs:210`) nên không bao giờ bị
   deny. Không còn nguy hiểm như trước — symlink đã giới hạn được vai thấy skill nào — nhưng
   một vai vẫn gọi được skill user/plugin cài ngoài repo.
4. **`librarian` mâu thuẫn ACL**: PLAYBOOK bước 5 bảo ghi `memory/shared/reference/` nhưng
   `memory.write: []`. Vai sẽ bị chặn ở đúng bước cuối quy trình của nó.
5. **`titling` thừa grant**: có `workspaces.read` nhưng `tools: []` → không đọc được gì.
6. **`~/StudioProjects/alp-plugin` không tồn tại** trên máy; 6/8 vai đang khai workspace này.
