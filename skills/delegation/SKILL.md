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
