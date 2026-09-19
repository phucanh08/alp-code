---
name: delegation
description: "Delegate work through ALP's runtime-neutral Delegation API with role policy, prepared context, execution lifecycle, and backend selection enforced by ALP."
---

# ALP Delegation

When work should be delegated, use ALP's delegation mechanism:

```bash
alp delegate <role> --project <path> -- "<task>"
alp delegate <role> --background -- "<task>"
alp delegation status <execution-id>
alp delegation wait <execution-id>
alp delegation cancel <execution-id>
alp delegation cleanup <execution-id>
alp delegation list
```

`scripts/run-role.*` remains a compatibility facade and calls the same service.

## Which role

`worker` is the generic one, and the only role that can write to the workspace: every file
change goes through it. `main` holds no `Write`/`Edit` and no write root, so "small enough to
just do myself" is not a question it can answer any more.

| Target | For |
|---|---|
| `worker` | any work that changes files — implement, fix, refactor, add tests |
| `search` | finding code, call sites, and impact in the local repo |
| `librarian` | external docs or another repository |
| `read-thread` | decisions and facts already in memory |
| `review` | one named review concern, with evidence |
| `oracle` | a second opinion on a hard or high-stakes call |

A `worker` task is one cut of work, stated so that it can be checked: what is in scope, what
the result should be, and how it will be verified. `worker` delegates to nobody — if it would
have to go ask `search` halfway through, the cut was wrong, not its grants.

## State the assignment, not just the task

`worker` owns one outcome with a boundary. Give it the boundary as fields, not as prose it
has to dig out of the task:

```bash
alp delegate worker --write-scope src --exclude-scope src/parser \
  --objective 'The lexer emits one token per literal' \
  --verification 'npx vitest run test/lexer' \
  --require-evidence change --require-evidence verify:test \
  -- 'Rewrite the lexer in src/lexer to tokenize literals one at a time.'
```

`--objective` is what done means; `--write-scope` is what it owns; `--exclude-scope` is the
part inside that scope another execution owns (two live workers may not own the same path —
`WRITE_SCOPE_OVERLAP` says which one already does); `--verification` is how you will check.
ALP renders these as an `Objective / Owned paths / Excluded paths / Verification` block in
front of the task, with the paths the sandbox actually enforces.

## Read the outcome before the prose

`alp delegation wait <id> --json` carries `outcome: { disposition, reason, evidenceRefs }` —
what the child *itself* says about how the work ended, separate from `status` (did the
process end) and `evidence` (did the workspace change). Read it first:

| `disposition` | It means | You do |
|---|---|---|
| `done` | the task as written is finished and verified, says the child | verify against `evidence`, then `accept` or `reject` |
| `reopen-request` | the premise was wrong — the file, symbol or bug the task named is not as described; the child left the workspace alone | data about **your** framing, not disobedience: read `evidenceRefs`, correct the task, delegate again; never re-send the same task |
| `dependency-request` | an input is missing — a file, a decision, an approval, another execution's result | supply it (or take it to the principal), then delegate again |
| `blocked` | the premise holds but something outside the child's authority stopped it — a denied write, a prerequisite it may not touch | clear it (scope, approval, prerequisite) and delegate again |
| `unknown` | no trailer, an unrecognised value, or the child died before reporting | not done; read the prose and the evidence, and treat the work as unverified |

`status: completed` with `disposition: reopen-request` is a normal, good result: a worker
that refuses a wrong premise cleanly is worth more than one that changes code to fit it.
Close it like any other delegation — `accept` when the refusal was right, `reject --reason`
when it was not — and the record keeps the disposition the child declared.

## Commit goes through `worker` too

`main`'s workspace is read-only *including `.git`*: `git commit` from `main` fails with
`Operation not permitted`, and that is the design, not a broken sandbox. Principal approval
does not change what the seat can write — it changes who may be asked to write. So when the
principal approves a commit or push, hand it to `worker` as a task of its own:

```bash
alp delegate worker --require-evidence change -- "Principal approved this commit. On branch
fix/parser, stage src/parser/index.ts and test/parser.test.ts only, commit with message
'fix(parser): không nuốt dấu đóng ngoặc' and report the hash. Do not push."
```

Name the approval, the branch, the files, and the exact message; say whether a push was
approved. Then `wait`, read the hash from the worker's report, check `evidence` shows a
`change` item carrying that commit, and only then tell the principal it is committed. A
push is a separate approval and a separate line in the task.

Do not invoke runtime-specific delegation tools directly. In particular, do not call
`paseo`, `create_agent`, or `spawn_agent` to delegate ALP work.

ALP policy determines:

- which role may delegate;
- which role can be targeted (`delegates_to`);
- what identity and task context is passed;
- what project/shared/private memory is visible;
- which workspace and write policy apply.

The backend only runs the prepared execution: it spawns the runtime as a child process and
owns nothing about role, ACL, memory, or task ownership. There is one backend and no way to
select another — `--backend` and `alp delegation switch` were removed on 2026-09-03.

If `--project` is omitted, the execution workspace is the caller's current directory. ALP
pins that canonical path into context and blocks access to other registered source workspaces
for the duration of the execution. Prefer an explicit absolute `--project` for important work.

The principal may talk to a role directly. In direct sessions, answer the principal. In a
delegated execution, return lifecycle/results to the delegation parent; direct interaction
still does not expand ACL or `delegates_to`.

Use `alp delegation health` for generic diagnosis. Runtime-specific tools are reserved for
principal/admin maintenance outside delegated role sessions.
