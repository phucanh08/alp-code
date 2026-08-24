---
name: delegation-switch
description: "Show or switch ALP's effective delegation backend between Herdr and Paseo from Claude Code or Codex, including resetting to the configured default. Use when the principal asks to change, inspect, or reset the delegation runtime."
---

# Delegation Switch

Use ALP's neutral switch command. Never edit `alp.config.yaml`, mutate shell profiles, or
call `herdr`/`paseo` directly.

- No argument or `status`: run `alp delegation switch` and report `backend` + `source`.
- `herdr` or `paseo`: run `alp delegation switch <backend>` and report the result.
- `default` or `reset`: run `alp delegation switch default`; this removes the interactive
  choice and returns to the environment/config default.

The switch affects future delegation requests from both Claude Code and Codex. Existing
executions remain owned by the backend recorded when they were spawned.

If the principal asks for a backend only for one delegation, do not persist a switch. Pass
`--backend <name>` to that single `alp delegate` request instead.

If ALP refuses because the target backend is unhealthy, stop and show its remediation. Do
not bypass the check or invoke runtime-specific maintenance unless the principal separately
asks for runtime debugging.

Typical explicit invocations:

```text
# Claude Code
/delegation-switch paseo

# Codex
$delegation-switch herdr
```
