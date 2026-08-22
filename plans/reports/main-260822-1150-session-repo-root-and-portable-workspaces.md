# Fix: repoRoot của phiên + workspaces không path tuyệt đối

Branch: `fix/session-repo-root-and-portable-workspaces`
Trạng thái: **ĐÃ ÁP** — commit f090563, PR https://github.com/phucanh08/alp-code/pull/1

Hai chỗ báo cáo này đoán sai, PR đã sửa:
- Di trú `loadout.yaml` KHÔNG tự động. `tildify` chỉ co được path trong home của máy hiện
  tại; `/Users/anhlp` là home máy khác nên `alp init` để nguyên. Đã sửa tay 9 file.
- `validate()` (dòng 260) chặn path không tuyệt đối — phải nới cho `~/...`, PR thêm mục 1g.

Ba file, năm thay đổi. Nội dung dưới đây là code cuối cùng, không phải mô tả.

---

## 1. `scripts/lib/loadout.cjs`

### 1a — thêm `os` vào require (dòng 6-7)

```js
const fs = require("fs");
const os = require("os");
const path = require("path");
```

### 1b — `sessionIdentity`: repo alp-code là chỗ HOOK nằm, không phải cwd

Thay dòng 117. Thêm đoạn doc vào cuối block comment sẵn có (sau dòng 114):

```js
 * Khi có `ALP_ROLE`, `fallbackFrom` đứng TRƯỚC cwd. `ALP_ROLE` chỉ do launcher đặt
 * (`alp`, `alp init`, `run-role`) ⇒ phiên đang ở trong một project, và repo alp-code là
 * chỗ hook nằm. Lấy cwd trước thì một project vô tình LÀ CLONE alp-code khác (dev clone)
 * sẽ được nhận nhầm làm nhà: clone đó không có `memory/` (gitignore), chưa compile ACL,
 * chưa trust. Hậu quả đo được: boot mất sạch `MEMORY INDEX` + `PROJECTS L0` mà không
 * cảnh báo, doctor phun ~50 dòng báo động giả, boot set phình 3 901 ký tự vượt ngân sách.
 */
function sessionIdentity(cwd, fallbackFrom, env = process.env) {
  const order = env.ALP_ROLE && fallbackFrom ? [fallbackFrom, cwd] : [cwd, fallbackFrom];
  const repoRoot = order.filter(Boolean).map(findRepoRoot).find(Boolean) || null;
  if (!repoRoot) return null;
```

Phần còn lại của hàm giữ nguyên.

### 1c — `~` hai chiều (chèn ngay trước `effectiveWorkspaces`, dòng ~146)

```js
/**
 * `~/x` → `<home>/x`. Chỉ `~` đứng đầu; `~user` không hỗ trợ — cố tình, `loadout.yaml`
 * phải đọc được bằng mắt trong 10 giây và home của user khác không phải thứ agent chạm.
 */
function untildify(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Chiều ngược lại — giữ `loadout.yaml` (file trong git) sạch path máy-cụ-thể. */
function tildify(p) {
  const abs = path.resolve(p);
  const rel = path.relative(os.homedir(), abs);
  if (rel === "") return "~";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return abs; // ngoài home: đành tuyệt đối
  return "~/" + rel.split(path.sep).join("/");
}
```

### 1d — `effectiveWorkspaces`: expand khi đọc (thay dòng 146-153)

```js
/**
 * Workspace code ngoài repo alp-code. Trong `loadout.yaml` path viết dạng `~/...` để file
 * còn dùng chung được giữa các máy; ở đây expand ra tuyệt đối vì MỌI consumer — acl-guard,
 * settings.json, project-config, doctor, run-role — đều cần path thật. Một chỗ expand duy
 * nhất, đừng thêm chỗ thứ hai.
 */
function effectiveWorkspaces(loadout) {
  const ws = loadout.workspaces || {};
  const norm = (list) => [...new Set((list || []).map((p) => path.resolve(untildify(p))))];
  return { read: norm(ws.read), write: norm(ws.write) };
}
```

### 1e — `writeWorkspaces`: co lại `~` khi ghi (thay dòng 163-168)

```js
  // Ghi lại dạng `~/...`: `loadout.yaml` nằm trong git. Path tuyệt đối của một máy lọt lên
  // remote là rác cho mọi máy khác — và làm thẻ danh tính lúc boot nói sai workspace.
  const fmt = (list) => [...new Set(list.map(tildify))].join(", ");
  const block = `workspaces:\n  read:  [${fmt(read)}]\n  write: [${fmt(write)}]`;

  const next = /^workspaces:\s*$/m.test(text)
    ? text.replace(/^workspaces:\s*$\n(?:^[ \t]+.*(?:\n|$))*/m, block + "\n")
    : text.trimEnd() + "\n\n# --- workspace code ngoài alp-code (viết dạng `~/...`) ---\n" + block + "\n";
```

Idempotency giữ nguyên: callers truyền path tuyệt đối từ `effectiveWorkspaces`, `tildify` đưa
về đúng chuỗi đang có trong file ⇒ `next === text` ⇒ `return false`.

### 1f — export (dòng ~373)

Thêm `untildify, tildify` vào `module.exports` để test gọi được.

---

## 2. `hooks/acl-guard.cjs` — `WRITE_INTENT` bắt nhầm (dòng 28-30)

```js
/**
 * Dấu hiệu lệnh Bash có ý định GHI. Thiếu sót là chấp nhận được — read-check vẫn chạy.
 *
 * Hai bẫy đã đo được, đừng gỡ:
 *  - `(?<!&)>>?(?!&)` — `2>&1` và `>&2` là NHÂN BẢN FD, không ghi file. `>` trần bắt cả
 *    chúng ⇒ mọi lệnh có `2>&1` bị write-check TOÀN BỘ token, kể cả `./scripts/doctor.sh`.
 *    `&>file` vẫn phải bắt nên để riêng một nhánh. `1>file` vẫn bắt được.
 *  - `install` phải đứng riêng như một lệnh: `\binstall\b` khớp cả trong đường dẫn
 *    `scripts/install-project.cjs` (dấu `-` là ranh giới từ) ⇒ đọc file đó cũng bị chặn.
 */
const WRITE_INTENT =
  /(&>|(?<!&)>>?(?!&)|\btee\b|\brm\b|\bmv\b|\bcp\b|\btouch\b|\bmkdir\b|\btruncate\b|\bdd\b|\bchmod\b|\bchown\b|\bln\b|\bsed\s+-i\b|\bpatch\b|(?:^|[\s;|&])install(?=[\s;|&]|$))/;
```

---

## 3. `hooks/session-start.cjs` — thiếu trí nhớ phải KÊU

### 3a — `filteredIndex` nhận `warnings` (dòng 132-134) và call site (dòng 99)

```js
function filteredIndex(repoRoot, grants, warnings) {
  const file = path.join(repoRoot, "memory", "INDEX.md");
  if (!fs.existsSync(file)) {
    // Boot KHÔNG có mục lục trí nhớ mà im lặng thì hỏng nặng hơn boot thừa cảnh báo:
    // agent tưởng mình không có gì để nhớ. Cùng lý do với BOOT_BUDGET — không cắt thầm.
    warnings.push(`thiếu ${file} — phiên này boot KHÔNG có mục lục trí nhớ`);
    return null;
  }
```

```js
  push("MEMORY INDEX (đã lọc theo quyền của bạn)", stripDocHeader(filteredIndex(repoRoot, grants, warnings)));
```

### 3b — `read()` nói đúng bệnh và đúng repo (dòng 189-195)

```js
/** `note` mặc định hợp cho file persona; file khác truyền note riêng. */
function read(file, warnings, note = "vai này chưa đủ bộ file") {
  if (!fs.existsSync(file)) {
    // Path ĐẦY ĐỦ, không phải basename: khi hook nhận nhầm repo, "thiếu INDEX.md" không
    // nói được là thiếu ở repo nào — đó chính là thứ làm chẩn đoán mất thời gian.
    warnings.push(`thiếu ${file} — ${note}`);
    return null;
  }
  return fs.readFileSync(file, "utf8");
}
```

Và call site dòng 100:

```js
  push("PROJECTS L0", stripDocHeader(read(
    path.join(repoRoot, "memory", "projects", "INDEX.md"), warnings,
    "chưa project nào đăng ký — `alp init <path>`"
  )));
```

---

## 4. (đề xuất thêm) `scripts/alp.cjs` — chặn `alp init` lên một clone alp-code

Gốc rễ của cả sự cố này: `alp init` đã chạy trên `~/AnhlpProjects/alp-code`, một clone
alp-code khác. Dòng 83 chỉ chặn khi hai thư mục chứa lẫn nhau, không chặn clone rời:

```js
  if (fs.existsSync(path.join(projectPath, "CHARTER.md")))
    die(`${projectPath} là một checkout alp-code — không \`alp init\` lên chính hệ này.\n` +
        "Dev alp-code thì mở `claude` trần trong clone đó, đừng để nó chạy dưới ACL của main.");
```

---

## Kiểm chứng sau khi áp

```
node scripts/test-isolation.cjs
node scripts/test-project-config.cjs
node scripts/test-agent-routing.cjs
node scripts/compile-acl.cjs
./scripts/doctor.sh --quiet          # kỳ vọng exit 0
./scripts/doctor.sh --quiet 2>&1     # kỳ vọng KHÔNG còn bị acl-guard chặn
```

Di trú dữ liệu cho việc 3 **không cần sửa tay**: sau khi 1e vào, chạy `alp init` một lần
là 8 `loadout.yaml` tự viết lại thành `~/...`.

Kỳ vọng boot sau fix: ~17 100 ký tự (ngưỡng 18 000). Biên chỉ ~5% — xem "câu hỏi mở".

---

## Câu hỏi mở

1. `/Users/anhlp/StudioProjects/alp-plugin` → `~/StudioProjects/alp-plugin` giả định máy kia
   để alp-plugin ngay dưới home. Đúng không? Nếu layout khác thì `~` không cứu được, phải
   tách `workspaces` ra file local ngoài git.
2. Sau fix 1b, `~/AnhlpProjects/alp-code/scripts/**` nằm NGOÀI repoRoot ⇒ hết FROZEN, main
   ghi được như workspace thường. Đó là ý bạn khi đăng ký clone làm workspace write, hay
   muốn chặn hẳn?
3. Boot còn ~900 ký tự biên. Có muốn hạ tiếp bằng cách đẩy `HOUSE-RULES` phần chi tiết
   xuống skill không, hay để đó và xử khi nào chạm ngưỡng?
