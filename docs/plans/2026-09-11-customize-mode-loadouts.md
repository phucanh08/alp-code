# Customize Mode Loadouts Documentation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Publish a discoverable user guide that explains the `v0.13.0` mode matrix and how to customize the five built-in loadouts with machine, project, and project-local settings.

**Architecture:** Keep `concepts/modes-and-runtimes.md` as the concise mental model and add one practical guide as the source of truth for configuration recipes. Other user pages link to that guide instead of duplicating merge and precedence rules.

**Tech Stack:** Markdown/Starlight content, JSON sidebar, Node.js documentation checks.

---

### Task 1: Add the practical loadout guide

**Files:**
- Create: `docs/user/guides/customize-mode-loadouts.md`
- Modify: `docs/user/sidebar.json`

**Step 1: Write the guide skeleton**

Add frontmatter and sections for supported mode IDs, the three settings files, precedence,
merge semantics, examples, reset behavior, constraints, and verification.

**Step 2: Add exact configuration examples**

Include complete valid JSON examples for:

```json
{
  "modes": {
    "medium": {
      "worker": { "model": "gpt-5.6-terra", "reasoningEffort": "medium" }
    }
  }
}
```

and a layered project/local example showing that the local file only needs the field it
changes. State explicitly that arbitrary mode names are unsupported.

**Step 3: Add the guide to navigation**

Add `guides/customize-mode-loadouts` to the “Hướng dẫn” group immediately after project setup.

**Step 4: Validate the sidebar**

Run:

```bash
node -e 'JSON.parse(require("node:fs").readFileSync("docs/user/sidebar.json", "utf8")); console.log("sidebar ok")'
```

Expected: `sidebar ok`.

**Step 5: Commit**

```bash
git add docs/user/guides/customize-mode-loadouts.md docs/user/sidebar.json
git commit -m "docs(user): add mode loadout guide"
```

### Task 2: Make the routing model visible from existing pages

**Files:**
- Modify: `docs/user/concepts/modes-and-runtimes.md`
- Modify: `docs/user/getting-started/quickstart.md`
- Modify: `docs/user/guides/project-setup.md`
- Modify: `docs/user/reference/cli.md`

**Step 1: Expand the mode matrix**

Replace the worker/oracle-only table with a compact table containing `main`, `worker`, and
`oracle`, including reasoning effort. Follow it with a callout: `main` remains
`claude-opus-5 · high` for `low` through `ultra`; the dial changes the working and second-opinion
seats; `puck` is the all-Codex exception.

**Step 2: Replace the abbreviated settings walkthrough**

Keep the three-file summary and boundaries in the concepts page, but link the detailed recipes
to `../../guides/customize-mode-loadouts/`. Do not duplicate every example.

**Step 3: Add discoverability links**

- Quickstart: link “tùy biến loadout” after the initial mode choice.
- Project setup: point both settings files to the new guide.
- CLI reference: point the mode settings sentence to the new guide while retaining the concepts link for routing semantics.

**Step 4: Search for stale or ambiguous wording**

Run:

```bash
rg -n "custom mode|tùy biến loadout|main.*Opus|settings\.local\.json" docs/user
```

Expected: no claim that a new mode ID can be created and no claim that `main` changes across the four difficulty modes.

**Step 5: Commit**

```bash
git add docs/user/concepts/modes-and-runtimes.md docs/user/getting-started/quickstart.md docs/user/guides/project-setup.md docs/user/reference/cli.md
git commit -m "docs(user): clarify mode routing and overrides"
```

### Task 3: Verify the published documentation set

**Files:**
- Verify: `docs/user/**/*.md`
- Verify: `docs/user/sidebar.json`

**Step 1: Run the release drift check**

```bash
node scripts/check-docs-drift.cjs
```

Expected: exit 0 and `docs/user/ đã nói về v0.13.0`.

**Step 2: Run the checker tests**

```bash
node scripts/test-check-docs-drift.cjs
```

Expected: exit 0 and all cases report PASS.

**Step 3: Run TypeScript verification**

```bash
npm run typecheck
```

Expected: exit 0.

**Step 4: Inspect final diff and links**

```bash
git diff main...HEAD --check
git diff main...HEAD -- docs/user docs/plans
```

Expected: no whitespace errors; every new relative link follows the trailing-slash Starlight convention.

**Step 5: Confirm clean branch state**

```bash
git status --short --branch
```

Expected: branch `docs/mode-loadout-guide` with no uncommitted files.
