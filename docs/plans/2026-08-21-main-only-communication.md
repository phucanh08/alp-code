# Main-only Communication Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Phở (`main`) the only principal-facing role and make every subordinate refuse direct principal tasks and report only to `main`.

**Architecture:** Add the communication contract at root, shared-rule, role-entrypoint, and role-template layers. Extract small CommonJS validators so `doctor` can detect topology drift and the Codex launcher can wrap every retrieval task with explicit `main` delegation metadata. Treat this as a semantic guardrail, not caller authentication.

**Tech Stack:** Markdown instruction files, Node.js CommonJS, Bash wrappers, Codex `AGENTS.md` discovery, existing `loadout.yaml` parser.

**Design:** `docs/plans/2026-08-21-main-only-communication-design.md`

---

### Task 1: Add a tested communication-topology validator

**Files:**
- Create: `scripts/lib/communication.cjs`
- Create: `scripts/test-communication.cjs`
- Create: `scripts/test-communication.sh`
- Modify: `scripts/doctor.cjs`

**Step 1: Write the failing validator tests**

Create `scripts/test-communication.cjs` with temporary fixtures and Node's built-in `assert`:

```js
#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ENTRYPOINT_CONTRACT, checkCommunicationTopology } = require("./lib/communication.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alp-code-communication-"));
try {
  write("AGENTS.md", "Phở is the default principal-facing role\n");
  write("identity/main/AGENTS.md", "Phở is main\n");
  write(`identity/search/AGENTS.md`, ENTRYPOINT_CONTRACT);
  write(`identity/search/CLAUDE.md`, ENTRYPOINT_CONTRACT);
  write(`identity/_template/AGENTS.md`, ENTRYPOINT_CONTRACT);
  write(`identity/_template/CLAUDE.md`, ENTRYPOINT_CONTRACT);
  write("identity/_template/loadout.yaml", "reports_to: main\n");

  const roles = ["main", "search"];
  const loadouts = { main: { reports_to: "principal" }, search: { reports_to: "main" } };
  assert.deepStrictEqual(checkCommunicationTopology(root, roles, (role) => loadouts[role]), []);

  loadouts.search.reports_to = "principal";
  assert(checkCommunicationTopology(root, roles, (role) => loadouts[role])
    .some((item) => item.tag === "COMMS-TOPOLOGY"));
  loadouts.search.reports_to = "main";

  fs.writeFileSync(path.join(root, "identity/search/AGENTS.md"), "missing contract\n");
  assert(checkCommunicationTopology(root, roles, (role) => loadouts[role])
    .some((item) => item.tag === "COMMS-CONTRACT"));

  console.log("OK               communication topology tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function write(relative, text) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
```

Create the wrapper:

```bash
#!/usr/bin/env bash
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/test-communication.cjs" "$@"
```

**Step 2: Run the test to verify it fails**

Run: `node scripts/test-communication.cjs`

Expected: FAIL with `Cannot find module './lib/communication.cjs'`.

**Step 3: Implement the minimal validator**

Create `scripts/lib/communication.cjs`:

```js
const fs = require("fs");
const path = require("path");

const ENTRYPOINT_CONTRACT = "Kênh giao tiếp — chỉ qua main";

function checkCommunicationTopology(repoRoot, roles, loadLoadout) {
  const issues = [];
  const add = (tag, msg) => issues.push({ tag, msg });
  const exists = (relative) => fs.existsSync(path.join(repoRoot, relative));
  const contains = (relative, needle) =>
    exists(relative) && fs.readFileSync(path.join(repoRoot, relative), "utf8").includes(needle);

  if (!exists("AGENTS.md")) add("COMMS-MISSING", "thiếu AGENTS.md ở repo root");
  if (!exists("identity/main/AGENTS.md")) add("COMMS-MISSING", "main thiếu AGENTS.md");

  for (const role of roles) {
    const expected = role === "main" ? "principal" : "main";
    const actual = loadLoadout(role)?.reports_to;
    if (actual !== expected)
      add("COMMS-TOPOLOGY", `${role} phải reports_to: ${expected}, hiện là ${actual || "rỗng"}`);

    if (role !== "main") {
      for (const file of [`identity/${role}/AGENTS.md`, `identity/${role}/CLAUDE.md`])
        if (!contains(file, ENTRYPOINT_CONTRACT))
          add("COMMS-CONTRACT", `${file} thiếu contract giao tiếp qua main`);
    }
  }

  for (const file of ["identity/_template/AGENTS.md", "identity/_template/CLAUDE.md"])
    if (!contains(file, ENTRYPOINT_CONTRACT))
      add("COMMS-CONTRACT", `${file} thiếu contract giao tiếp qua main`);
  if (!contains("identity/_template/loadout.yaml", "reports_to: main"))
    add("COMMS-TOPOLOGY", "template vai mới phải reports_to: main");

  return issues;
}

module.exports = { ENTRYPOINT_CONTRACT, checkCommunicationTopology };
```

In `scripts/doctor.cjs`, import the helper, add `checkCommunication()`, and call it from `main()`:

```js
const C = require("./lib/communication.cjs");

function checkCommunication() {
  for (const issue of C.checkCommunicationTopology(
    repoRoot,
    roles,
    (role) => L.loadLoadout(repoRoot, role)
  )) signal(issue.tag, issue.msg);
}
```

Call `checkCommunication()` after `checkRegistry()` and before `checkIdentityFiles()`.

**Step 4: Run the focused test**

Run: `node scripts/test-communication.cjs`

Expected: `OK               communication topology tests passed`.

**Step 5: Confirm doctor now exposes the missing policy files**

Run: `scripts/doctor.sh --quiet`

Expected: exit 1 with `COMMS-MISSING`, `COMMS-CONTRACT`, and template `COMMS-TOPOLOGY` signals. Existing unrelated environment signals such as `TRUST-MISSING` may also appear.

**Step 6: Commit**

```bash
git add scripts/lib/communication.cjs scripts/test-communication.cjs scripts/test-communication.sh scripts/doctor.cjs
git commit -m "test: validate main-only communication topology"
```

### Task 2: Establish Phở as the only principal-facing entrypoint

**Files:**
- Create: `AGENTS.md`
- Create: `identity/main/AGENTS.md`
- Create: `identity/_template/AGENTS.md`
- Modify: `identity/_shared/HOUSE-RULES.md`
- Modify: `identity/_shared/PRINCIPAL.md`
- Modify: `identity/_template/CLAUDE.md`
- Modify: `identity/_template/loadout.yaml`
- Modify: `identity/search/AGENTS.md`
- Modify: `identity/search/CLAUDE.md`
- Modify: `identity/librarian/AGENTS.md`
- Modify: `identity/librarian/CLAUDE.md`
- Modify: `identity/read-thread/AGENTS.md`
- Modify: `identity/read-thread/CLAUDE.md`
- Modify: `identity/review/AGENTS.md`
- Modify: `identity/review/CLAUDE.md`
- Modify: `identity/oracle/AGENTS.md`
- Modify: `identity/oracle/CLAUDE.md`

**Step 1: Add the root Codex entrypoint**

Create `AGENTS.md` with these rules:

```md
# Phở — default Codex entrypoint

When Codex starts at the repository root, you are `main`, named **Phở 🍜**. Load
`identity/main/loadout.yaml`, `IDENTITY.md`, `SOUL.md`, `PLAYBOOK.md`, `RELATIONS.md`, and
the boot files in `identity/_shared/` before substantive work.

Phở is the only principal-facing role. Phở may delegate to roles listed in
`identity/main/loadout.yaml`, but Phở alone asks the principal questions, reports progress,
combines results, and gives the final answer.

When a nested `identity/<role>/AGENTS.md` identifies a subordinate role, that closer identity
wins. Apply the shared communication contract: the subordinate communicates only with
`reports_to` and refuses direct principal tasks.
```

**Step 2: Add the main Codex entrypoint**

Create `identity/main/AGENTS.md` mirroring `identity/main/CLAUDE.md`, explicitly stating that
Phở is the sole principal-facing role and that delegated output is verified and synthesized
before it reaches the principal.

**Step 3: Add the source-of-truth communication rule**

Add a `## Kênh giao tiếp — chỉ qua main` section to `identity/_shared/HOUSE-RULES.md`:

```md
## Kênh giao tiếp — chỉ qua main

- Chỉ vai có `reports_to: principal` mới nhận yêu cầu và giao tiếp trực tiếp với principal.
- Vai có `reports_to: main` chỉ nhận nhiệm vụ do `main` giao qua kênh delegation đã duyệt.
- Mọi câu hỏi, tiến độ, lỗi, artifact và kết quả của vai phụ chỉ gửi về `main`.
- Nếu principal mở vai phụ trực tiếp hoặc giao việc ngoài delegation, vai đó không phân tích
  hay thực hiện nhiệm vụ, không gọi tool, và chỉ trả một lời chuyển hướng ngắn:
  “Mình là <Tên vai>, chỉ nhận nhiệm vụ từ Phở. Bạn vui lòng làm việc qua Phở 🍜.”
- Báo lỗi boot/hook vẫn được phép vì đó là lỗi vận hành, không phải nhận nhiệm vụ trực tiếp.
```

Record the same preference as a principal fact in `identity/_shared/PRINCIPAL.md`.

**Step 4: Put the compact contract at every subordinate entrypoint**

Add this section to every non-main `AGENTS.md`, every non-main `CLAUDE.md`, and both template
entrypoints:

```md
## Kênh giao tiếp — chỉ qua main

Chỉ nhận nhiệm vụ do `main` giao qua kênh delegation đã duyệt và chỉ trao đổi/trả kết quả
cho `main`. Nếu principal mở phiên trực tiếp hoặc giao việc ngoài delegation, không thực hiện
nhiệm vụ và chỉ chuyển hướng ngắn về Phở 🍜.
```

Create `identity/_template/AGENTS.md` with the normal Codex identity-loading instructions plus
this section. Change `identity/_template/loadout.yaml` from `reports_to: principal` to
`reports_to: main` so new roles inherit the topology.

**Step 5: Run focused validation**

Run: `node scripts/test-communication.cjs`

Expected: PASS.

Run: `scripts/doctor.sh --quiet`

Expected: no `COMMS-*` signals. Other pre-existing environmental signals are allowed only if
recorded explicitly.

**Step 6: Commit**

```bash
git add AGENTS.md identity
git commit -m "feat: route principal communication through Pho"
```

### Task 3: Mark every Codex retrieval run as delegated by main

**Files:**
- Create: `scripts/lib/delegation.cjs`
- Create: `scripts/test-delegation.cjs`
- Modify: `scripts/run-role.cjs`

**Step 1: Write the failing prompt-contract test**

Create `scripts/test-delegation.cjs`:

```js
#!/usr/bin/env node
const assert = require("assert");
const { wrapDelegatedPrompt } = require("./lib/delegation.cjs");

const prompt = wrapDelegatedPrompt("Tìm luồng authentication");
assert(prompt.includes("do `main` (Phở 🍜) giao"));
assert(prompt.includes("chỉ gửi về `main`"));
assert(prompt.includes("không giao tiếp trực tiếp với principal"));
assert(prompt.endsWith("Tìm luồng authentication"));
console.log("OK               delegation prompt tests passed");
```

**Step 2: Run the test to verify it fails**

Run: `node scripts/test-delegation.cjs`

Expected: FAIL with `Cannot find module './lib/delegation.cjs'`.

**Step 3: Implement the prompt wrapper**

Create `scripts/lib/delegation.cjs`:

```js
function wrapDelegatedPrompt(task) {
  return [
    "# NGUỒN ỦY NHIỆM",
    "",
    "Nhiệm vụ này do `main` (Phở 🍜) giao qua launcher delegation đã duyệt.",
    "Mọi câu hỏi, tiến độ, lỗi và kết quả chỉ gửi về `main`; không giao tiếp trực tiếp với principal.",
    "",
    "# NHIỆM VỤ",
    "",
    task,
  ].join("\n");
}

module.exports = { wrapDelegatedPrompt };
```

Update `scripts/run-role.cjs` to import the helper and replace its inline `# NHIỆM VỤ`
construction:

```js
const D = require("./lib/delegation.cjs");
const userPrompt = promptParts.join(" ").trim() || "Báo main rằng chưa có nội dung nhiệm vụ.";
const prompt = `${boot}\n\n${D.wrapDelegatedPrompt(userPrompt)}`;
```

Also include non-sensitive delegation metadata in `--dry-run` output:

```js
delegation: { from: "main", replyTo: "main", principalFacing: false }
```

**Step 4: Run focused tests**

Run: `node scripts/test-delegation.cjs`

Expected: `OK               delegation prompt tests passed`.

Run: `scripts/run-role.sh librarian --dry-run -- "Tìm tài liệu"`

Expected: JSON includes `"from": "main"`, `"replyTo": "main"`, and
`"principalFacing": false` without launching Codex.

**Step 5: Commit**

```bash
git add scripts/lib/delegation.cjs scripts/test-delegation.cjs scripts/run-role.cjs
git commit -m "feat: mark retrieval tasks as main delegations"
```

### Task 4: Document and verify the completed behavior

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/2026-08-21-main-only-communication-design.md` only if implementation
  reveals a material design deviation

**Step 1: Document the user-facing rule**

Near the top of `README.md`, state that the principal always starts and communicates through
Phở, while role launchers are internal delegation mechanisms used by main. Keep the existing
commands but label them as main/operator tooling, not alternate principal-facing chats.

Add `scripts/test-communication.sh` to the scripts table.

**Step 2: Run whitespace and focused tests**

Run:

```bash
git diff --check
node scripts/test-communication.cjs
node scripts/test-delegation.cjs
```

Expected: `git diff --check` exits 0 and both tests print `OK`.

**Step 3: Run system verification**

Run:

```bash
scripts/doctor.sh
scripts/compile-acl.sh --check
scripts/test-isolation.sh
scripts/run-role.sh librarian --dry-run -- "Kiểm tra contract"
```

Expected:

- `doctor.sh` reports clean, or only clearly identified pre-existing machine-local trust
  warnings.
- ACL check reports no drift.
- All isolation cases pass.
- Dry-run reports delegation from and back to `main`, with `principalFacing: false`.

**Step 4: Inspect the final diff**

Run: `git diff --stat HEAD~3 && git diff HEAD~3 -- AGENTS.md identity scripts README.md`

Expected: only the approved communication, launcher, validation, and documentation changes.

**Step 5: Commit documentation**

```bash
git add README.md docs/plans/2026-08-21-main-only-communication-design.md
git commit -m "docs: explain main-only agent communication"
```

**Step 6: Request code review and apply only verified findings**

Use `superpowers:requesting-code-review`, review the complete diff against the approved
design, rerun any affected tests, then use `superpowers:verification-before-completion`
before reporting success.
