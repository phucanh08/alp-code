# Layered ALP settings and installation layout

**Date:** 2026-09-05  
**Status:** Approved

## Context

ALP currently compiles the five mode loadouts into `src/agents/modes.ts` and remembers the
machine-local mode in `~/.alp/mode.json`. Users cannot change the model or reasoning effort for
an agent without modifying and rebuilding the application. The default installer also clones the
application into `~/.alp-code`, while runtime state already lives in `~/.alp`.

This design introduces Claude-style JSON settings with a global layer and a project-local layer.
It also consolidates the user-facing installation namespace under `~/.alp` without mixing the Git
checkout with mutable settings and execution state.

## Goals

- Create a user-owned `~/.alp/setting.json` containing the selected mode and the complete shipped
  model/effort mapping.
- Support partial project overrides in `<project>/.alp/setting.local.json`.
- Let every built-in agent be configured independently in every existing mode.
- Preserve the invariant that the selected model determines the runtime.
- Make the resolved model, effort, and runtime part of the immutable execution policy and hash.
- Install the application at `~/.alp/app` by default and migrate a legacy `~/.alp-code` checkout
  without losing settings, state, or memory.

## Non-goals

- Custom mode names.
- Custom agents or changes to agent permissions, skills, delegation grants, or workflows.
- Guessing a runtime from a model name. Models remain restricted to ALP's explicit model catalog.
- Replacing `alp.config.yaml` delegation state configuration in this change.

## Files and ownership

The default layout is:

```text
~/.alp/
├── app/                         # ALP Git checkout
├── setting.json                # user-wide settings, mode 0600
├── projects.json
├── principal.json
├── executions/
└── delegation/

<project>/.alp/
├── setting.local.json          # project-local partial override, mode 0600
└── agents/
```

`ALP_HOME` and `--home` continue to mean an explicit application checkout path. Only their
default changes to `~/.alp/app`.

The global file is user-owned. Bootstrap may create it and add newly shipped keys that are
missing, but never overwrites an existing value. The project-local file is also user-owned after
`alp init` creates its empty template. It is added to `.git/info/exclude`, not `.gitignore`, so it
does not alter repository policy or appear in commits by default.

## JSON contract

The public spelling is `agent-teams`, not `roles`:

```json
{
  "$schema": "https://raw.githubusercontent.com/phucanh08/alp-code/main/schemas/setting.schema.json",
  "mode": "medium",
  "modes": {
    "high": {
      "agent-teams": {
        "main": {
          "model": "gpt-5.6-sol",
          "reasoningEffort": "xhigh"
        },
        "oracle": {
          "model": "claude-opus-5",
          "reasoningEffort": "high"
        }
      }
    }
  }
}
```

The global file generated on first installation contains all five modes and all eight built-in
agents. A local file may contain only the fields it wants to override. The schema accepts:

- `mode`: `low`, `medium`, `high`, `ultra`, or `puck`.
- `modes`: an object keyed by those same five IDs.
- `agent-teams`: an object keyed by built-in agent ID.
- Each agent entry: a partial `{ model, reasoningEffort }` object.
- `model`: a model registered in the explicit ALP model-to-runtime catalog.
- `reasoningEffort`: `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`.

Unknown fields, modes, agents, models, and efforts are errors. The `$schema` key is optional at
runtime and exists for editor completion and validation.

## Layering and mode precedence

Model loadouts merge deeply, field by field:

```text
compiled defaults
    < ~/.alp/setting.json
    < nearest ancestor <project>/.alp/setting.local.json
```

For example, a local override of only `modes.high.agent-teams.main.model` retains the global or
compiled `reasoningEffort` for that agent and every other agent in the mode.

The settings loader walks upward from `cwd` and uses the nearest `setting.local.json`, allowing an
ALP session started in a project subdirectory to retain project settings.

Mode selection uses this precedence:

```text
--mode
    > ALP_MODE
    > interactive TTY selection
    > project-local mode
    > global mode
    > medium
```

The effective configured mode seeds the interactive menu. The chosen menu value controls the
current session and updates only the global `mode` field. A project-local `mode` remains untouched
and seeds the next session in that project. In non-interactive execution, project-local/global
settings resolve directly. `alp mode set` updates only the global `mode` field while preserving
all mappings.

## Components and data flow

A settings module owns four responsibilities:

1. Parse and validate a settings document with path-aware errors.
2. Deep-merge compiled defaults, global settings, and a project-local overlay.
3. Resolve an immutable `{ mode, agent, model, reasoningEffort, runtime }` launch profile.
4. Atomically update the global mode without rewriting user mappings.

Each CLI invocation loads one effective settings snapshot. Main sessions and delegation use the
same resolver. They do not independently consult the compiled mode table after resolution.

Before an adapter is selected, the resolved launch profile goes into `ExecutionService.prepare`.
`ExecutionPolicy` records `mode`, `model`, `reasoningEffort`, and `runtime`; all four participate in
`policyHash`. `definitionHash` remains tied to the agent definition and does not change with mode
or user settings. The runtime adapter consumes the same snapshotted profile rather than accepting
a second independently resolved model/effort pair.

This produces one source of truth:

```text
settings snapshot
    -> selected mode
    -> resolved agent launch profile
    -> policy.json + policyHash
    -> runtime adapter
```

Changing either settings file after an execution has been prepared does not alter that execution.
A later execution loads a new snapshot and receives a different policy hash when its effective
launch profile changes.

## Validation and failure behavior

An absent global or local file means “no override.” Any other read failure is fatal. Malformed
JSON or an invalid field is fatal before policy preparation, runtime probing, or process spawn.
Errors name the source file and the failing property path.

The loader does not infer runtimes from prefixes such as `claude-` or `gpt-`. A configured model
must exist in `MODEL_RUNTIMES`; its catalog entry selects Claude Code or Codex. This preserves the
existing fail-closed routing invariant.

Global writes are atomic: write a `0600` temporary file in `~/.alp`, rename it over the target,
then enforce `0600` on the result. The directory remains `0700`. If parsing the existing global
file fails, `alp mode set` refuses to overwrite it because doing so could discard recoverable user
configuration.

## Bootstrap, update, and migration

On a fresh installation, the shell or PowerShell wrapper creates `~/.alp` and clones the checkout
into `~/.alp/app`. After building, bootstrap creates the complete global settings document from
the compiled defaults.

On later bootstrap runs, ALP fills only missing modes, agent entries, or fields from the new
shipped defaults. Existing values always win. This lets new agents or schema fields appear after
an update without resetting user choices.

The default-path legacy migration runs only when `ALP_HOME`/`--home` was not explicitly supplied:

- If `~/.alp/app` is absent and `~/.alp-code` is a valid ALP checkout, move the legacy checkout to
  `~/.alp/app` before updating and rebuilding it.
- Preserve the existing `~/.alp` state directory and the checkout's `memory/` directory.
- Rewire the CLI and rewrite only project hooks marked as generated by `alp init` so they point at
  the new checkout.
- If both checkout paths exist, use `~/.alp/app`, emit a warning, and leave `~/.alp-code` intact.
- Never delete or replace an unrecognized path automatically.

If `~/.alp/mode.json` exists while `setting.json` does not yet carry a mode, bootstrap imports a
valid legacy preference. It removes `mode.json` only after the new settings document has been
written successfully. Invalid legacy state produces a warning and leaves the old file in place.

`alp update` preserves settings and machine state across checkout/build failures. Uninstall logic
must account for the nested app root: memory backups are placed outside `~/.alp` before any state
cleanup, and cleanup targets are resolved explicitly so it cannot accidentally delete the home
directory or a custom installation parent.

## Testing

Unit tests cover:

- Parsing the complete global document and partial local documents.
- Deep merge at mode, agent, and field granularity.
- Mode precedence in interactive and non-interactive sessions.
- Strict path-aware failures for malformed JSON and unknown values.
- Atomic mode updates that preserve mappings and file permissions.
- Known-model runtime resolution.
- A changed resolved model or effort changing `policyHash` but not `definitionHash`.

Integration tests cover:

- Main and delegated agents resolving the same effective profile.
- Project-local discovery from a nested working directory.
- Runtime adapters consuming the snapshotted launch profile.
- `alp mode show|set`, menu persistence, and one-time `mode.json` migration.

Installer and maintenance fixtures cover Bash and PowerShell default paths, clean legacy moves,
the non-destructive both-paths case, initial settings generation, update preservation, generated
hook rewrites, and safe uninstall behavior. The existing TypeScript, script, and end-to-end test
suites remain the final regression gate.
