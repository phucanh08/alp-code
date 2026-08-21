# Main-only communication design

**Date:** 2026-08-21  
**Status:** Approved by principal

## Goal

The principal communicates only with `main` (Phở 🍜). Every other role receives work from
`main`, communicates only with `main`, and refuses tasks sent directly by the principal.

## Chosen approach

Use layered semantic guardrails backed by a mechanical integrity check:

1. Make the repository root and `identity/main/` explicit Codex entrypoints for Phở.
2. Put the communication topology in the shared rules loaded by every role.
3. Keep a compact role-specific refusal rule in non-main entrypoints so it is present even
   when a runtime hook fails.
4. Make delegated Codex prompts explicitly identify `main` as the sender and recipient.
5. Extend `doctor` to detect topology drift.

This is more reliable than duplicating prose alone and much lighter than adding delegation
tokens or runtime authentication. It is a behavioral guardrail, not a security boundary.

## Communication topology

```text
principal <-> main (Phở)
                 |
                 +-> search ------+
                 +-> librarian ---+
                 +-> read-thread -+--> main only
                 +-> review ------+
                 +-> oracle ------+
```

- Only a role whose `reports_to` is `principal` may converse with the principal.
- A role whose `reports_to` is another role accepts work only from that role through the
  approved delegation path.
- A subordinate returns questions, progress, artifacts, failures, and final results to its
  `reports_to`; it does not surface them directly to the principal.
- A subordinate never delegates unless its loadout explicitly allows it.

## Direct-contact behavior

When the principal opens a subordinate role directly or sends it a task outside delegation,
the role must not inspect the task, execute tools, modify files, or ask task-level questions.
It responds once with a short redirect such as:

> Mình là Search, chỉ nhận nhiệm vụ từ Phở. Bạn vui lòng làm việc qua Phở 🍜.

The role may still report a broken identity/session hook because that is an operational
failure, not acceptance of the principal's task.

## Entrypoints

- Root `AGENTS.md`: establish Phở as the default user-facing role when Codex starts at the
  repository root, while allowing nested role entrypoints to specialize identity.
- `identity/main/AGENTS.md`: establish the Codex entrypoint for Phở when started in the main
  directory.
- Non-main `AGENTS.md` and `CLAUDE.md`: state the refusal/redirect rule close to the runtime
  entrypoint. The shared rule remains the source of truth.
- The role template carries the subordinate behavior so newly created roles inherit it.

Codex loads project instructions from root toward the current working directory, so the root
file provides the default and nested role files provide the role-specific behavior.

## Delegated prompt contract

`scripts/run-role.cjs` will wrap a task with an explicit statement that:

- the task was delegated by `main`;
- all questions and output go back to `main`;
- the role must not address the principal.

This metadata makes normal delegated runs unambiguous. It is not cryptographic proof and is
not intended to resist a malicious caller.

## Validation

Automated checks will cover:

- the main role reports to `principal`;
- every active non-main role reports to `main`;
- the root and main Codex entrypoints exist;
- subordinate entrypoints include the direct-contact refusal contract;
- delegated Codex prompts identify `main` as sender and recipient;
- existing ACL/isolation checks still pass.

`scripts/doctor.sh` will surface topology drift so a new or edited role cannot silently break
the communication model.

## Non-goals

- Cryptographic authentication of who launched a role.
- Preventing a malicious principal or local process from spoofing a delegation prompt.
- Changing file ACLs or private-memory isolation.
- Allowing subordinate agents to communicate with one another.
