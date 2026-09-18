# Project Skill Links Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every built-in skill in `skills/` available while developing this checkout in both Claude Code and Codex.

**Architecture:** A repository-local CommonJS synchronizer treats `skills/` as source and maintains relative symlinks in `.claude/skills/` and `.codex/skills/`. It runs after dependency installation and remains available as an explicit npm command; foreign entries are preserved and reported as conflicts.

**Tech Stack:** Node.js 18 filesystem APIs, Vitest, npm lifecycle scripts.

---

### Task 1: Specify link synchronization

**Files:**
- Create: `test/scripts/sync-project-skills.test.ts`
- Create: `scripts/sync-project-skills.cjs`

**Step 1: Write the failing test**

Create fixtures in a temporary repo and require `syncProjectSkills` from the CommonJS script. Assert that it:

```ts
await syncProjectSkills(root);
expect(await readlink(join(root, ".claude/skills/alpha"))).toBe("../../skills/alpha");
expect(await readlink(join(root, ".codex/skills/alpha"))).toBe("../../skills/alpha");
```

Also assert a second run is idempotent, `release` remains untouched, a conflicting real directory causes a clear error without mutation, and a dangling owned link is removed.

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/scripts/sync-project-skills.test.ts`

Expected: FAIL because `scripts/sync-project-skills.cjs` does not exist.

**Step 3: Write minimal implementation**

Implement and export:

```js
function syncProjectSkills(repoRoot = path.resolve(__dirname, "..")) {
  // Validate real source skill directories containing SKILL.md.
  // Create relative links in both runtime roots.
  // Preserve/report foreign collisions.
  // Remove only stale symlinks whose target belongs to repoRoot/skills.
}
```

The CLI path prints a compact count and exits non-zero for conflicts. When invoked by npm in a packaged dependency without `.git`, it skips because this wiring belongs only to a source checkout.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/scripts/sync-project-skills.test.ts`

Expected: PASS.

### Task 2: Wire automatic synchronization

**Files:**
- Modify: `package.json`
- Modify: `README.md`

**Step 1: Write the failing lifecycle assertion**

Extend `test/scripts/sync-project-skills.test.ts` to read `package.json` and assert:

```ts
expect(pkg.scripts["sync:skills"]).toBe("node scripts/sync-project-skills.cjs");
expect(pkg.scripts.postinstall).toBe("npm run sync:skills");
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/scripts/sync-project-skills.test.ts`

Expected: FAIL because the npm scripts are absent.

**Step 3: Add npm lifecycle and documentation**

Add `sync:skills` and `postinstall` to `package.json`. Document that source checkouts expose built-in skills in `.claude/skills/` and `.codex/skills/`, while `release` remains project-only.

**Step 4: Run focused verification**

Run: `npx vitest run test/scripts/sync-project-skills.test.ts`

Expected: PASS.

### Task 3: Convert and verify this checkout

**Files:**
- Replace identical directories with links: `.claude/skills/alp-plan`, `.claude/skills/test-quality-guard`
- Generate links under: `.claude/skills/`, `.codex/skills/`

**Step 1: Prove copied directories are identical**

Run:

```bash
diff -qr skills/alp-plan .claude/skills/alp-plan
diff -qr skills/test-quality-guard .claude/skills/test-quality-guard
```

Expected: both exit 0.

**Step 2: Preserve then replace the two copies**

Move the two verified copies into a temporary backup outside the repo, run `npm run sync:skills`, and confirm all generated entries are relative symlinks. Keep `.claude/skills/release` and `.codex/skills/release` unchanged.

**Step 3: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
npm run sync:skills
git status --short
```

Expected: test/typecheck/build exit 0; repeat sync reports no changes; Git shows only intended tracked implementation changes and any pre-existing ignored runtime links remain untracked/ignored.

**Step 4: Review the diff**

Use `superpowers:requesting-code-review`, address material findings, and rerun the focused plus full verification before reporting completion.
