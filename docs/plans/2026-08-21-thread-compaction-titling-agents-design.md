# Thread Compaction and Titling Agents Design

**Date:** 2026-08-21  
**Status:** Approved by principal

## Goal

Add two main-only Codex roles for long-thread context summarization and fast thread title
generation, while making model reasoning effort an explicit, validated loadout setting.

## Chosen approach

Store `reasoning_effort` beside `model` in each Codex role's `loadout.yaml`. The role launcher
reads both fields, passes the effort to Codex, and exposes the resolved values in dry-run
output. `loadout.yaml` remains the single source of truth instead of duplicating a role-to-
effort map in launcher code or requiring callers to remember per-run flags.

## Roles

### Compaction 🗜️

- Slug: `compaction`
- Runtime: Codex
- Model: `gpt-5.6-sol`
- Reasoning effort: `medium`
- Reports to: `main`
- Delegates to: nobody
- Writes: nothing outside its private scratch area; normal operation returns an artifact only

Compaction receives a long thread or a context bundle from Phở and produces a continuation-
ready handoff. Its default structure contains:

1. objective;
2. constraints and user preferences;
3. decisions and rationale;
4. completed work and current state;
5. unresolved questions or risks;
6. concrete next actions;
7. exact anchors such as paths, commands, identifiers, and errors that must survive context
   replacement.

It preserves uncertainty and distinguishes verified facts from assumptions. It does not solve
the underlying task, research missing facts, write memory, or communicate with the principal.

### Titling 🏷️

- Slug: `titling`
- Runtime: Codex
- Model: `gpt-5.6-luna`
- Reasoning effort: `low`
- Reports to: `main`
- Delegates to: nobody
- Writes: nothing outside its private scratch area; normal operation returns one line

Titling receives enough thread content to identify the primary intent and returns exactly one
short title in the thread's main language. It does not add quotes, labels, explanations,
alternatives, trailing punctuation, or task execution.

## Existing role updates

- Search keeps the canonical model slug `gpt-5.6-terra` and gets
  `reasoning_effort: low`.
- Review keeps `gpt-5.5` and gets `reasoning_effort: medium`.

The requested display spelling “Tera” is normalized to the canonical local slug and role name
“Terra,” which already exists in the repository's model-routing source.

## Delegation and communication

`main.delegates_to` adds `compaction` and `titling`. Both roles inherit the main-only
communication contract:

- accept work only from Phở through the approved delegation launcher;
- return questions, failures, and results only to Phở;
- refuse direct principal tasks and redirect to Phở;
- never delegate to another role.

Phở uses Compaction when a thread is near context pressure or needs a durable handoff. Phở
uses Titling when a thread needs a fast, stable display title. Phở validates their output
before exposing or applying it.

## Launcher and loadout schema

`reasoning_effort` becomes an optional top-level loadout field for backward compatibility.
When present, it must be one of:

```text
low medium high xhigh max ultra
```

The launcher passes it as Codex configuration:

```text
-c model_reasoning_effort="<effort>"
```

Dry-run output includes the resolved effort. The allowed Codex role set adds `compaction`,
`titling`, and `review`, matching the documented operator commands and allowing Review's
medium effort to take effect through the same path.

No per-model effort matrix is added now: the four requested values are known-valid in the
local routing source, and a generic enum avoids duplicating volatile model capability data.

## ACL and creation path

Both roles are created through `scripts/new-role.sh`; no identity directory is copied by
hand. This ensures:

- registry entries are generated through the canonical path;
- private scratch directories exist;
- every existing role receives deny rules for both new private silos;
- generated Claude settings are recompiled consistently.

After scaffolding, placeholder identity files are replaced with final role-specific content,
then ACL is compiled again.

## Validation

Automated checks will cover:

- loadout parsing and validation of `reasoning_effort`;
- rejection of an unknown effort value;
- dry-run model and effort for Compaction, Titling, Search, and Review;
- launcher acceptance of the new roles and Review;
- both new roles reporting to `main` and appearing in `main.delegates_to`;
- absence of template placeholders;
- main-only communication contracts;
- registry/loadout consistency;
- regenerated ACL isolation for all eight roles.

## Documentation updates

Update `README.md`, `CHARTER.md`, `identity/REGISTRY.md`, `identity/main/RELATIONS.md`, and
`docs/model-routing.md` so the role roster, routing rules, model slugs, and efforts agree.

Official OpenAI documentation available during design did not expose a public page confirming
these environment-specific model slugs. The implementation therefore preserves the exact
locally configured slugs and uses the repository's model-routing source as the operational
authority.

## Non-goals

- Automatic context-window monitoring or automatic compaction triggers.
- Persisting Compaction output into shared/project memory.
- Generating multiple title candidates or ranking titles.
- Changing Search's retrieval scope or Review's review workflow.
- Authenticating delegation callers cryptographically.
