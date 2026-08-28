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
alp delegation switch [local|paseo|default]
```

`scripts/run-role.*` remains a compatibility facade and calls the same service.

Do not invoke runtime-specific delegation tools directly. In particular, do not call
`paseo`, `create_agent`, or `spawn_agent` to delegate ALP work.

ALP policy determines:

- which role may delegate;
- which role can be targeted (`delegates_to`);
- what identity and task context is passed;
- what project/shared/private memory is visible;
- which workspace and write policy apply.

The configured backend only runs the prepared execution. It may be local, Paseo, or a
future backend. Changing it must not change role, ACL, memory, or task ownership.
Run `alp delegation switch` to inspect or persistently change the backend. Keep
`--backend` for a one-request override.

If `--project` is omitted, the execution workspace is the caller's current directory. ALP
pins that canonical path into context and blocks access to other registered source workspaces
for the duration of the execution. Prefer an explicit absolute `--project` for important work.

The principal may talk to a role directly. In direct sessions, answer the principal. In a
delegated execution, return lifecycle/results to the delegation parent; direct interaction
still does not expand ACL or `delegates_to`.

Use `alp delegation health` for generic diagnosis. Runtime-specific tools are reserved for
principal/admin maintenance outside delegated role sessions.
