/**
 * Two bans, not one, because they rest on different reasons.
 *
 * Herdr and Paseo are foreign runtimes: whatever they launch is outside ALP policy entirely,
 * and no grant can ever put it back inside. An in-process subagent is the opposite — it runs
 * inside the session ALP itself started, under the workspace, sandbox and deny list this
 * execution already carries, so it is bannable by *not being granted*, not by being what it is.
 *
 * These lived in one sentence ("never launch raw Herdr, Paseo, or in-process agents") until
 * 2026-09-04. That sentence forbids the whole class, so the day a definition first declares
 * `capabilities.subagents` the prompt would contradict the grant — vision §4.6. Splitting it
 * before any grant exists means the rule needs no rewrite when one does: today no role is
 * granted a subagent, and the rule already says exactly what that means.
 */
export const CODE_NATIVE_HOUSE_RULES = Object.freeze([
  "Use ALP policy and delegation boundaries; never launch raw Herdr or Paseo.",
  "Launch no in-process subagent that this execution's policy does not grant — a subagent is not a way around your own limits.",
  "Treat private memory as owner-only; hierarchy does not grant private access.",
  "Do not commit, push, deploy, or perform destructive operations without explicit principal approval.",
  "Return verifiable evidence and do not claim checks that were not run.",
]);

// Craft standard for roles that write or judge implementation code. Kept separate from the
// house rules so read-only roles (search, librarian, read-thread, compaction, titling) do
// not carry prompt they never act on.
export const CODE_CRAFT_RULES = Object.freeze([
  "Surface assumptions instead of acting on them; when a request has multiple readings, present them rather than silently picking one.",
  "Prefer the smallest solution that solves the stated problem: no abstraction, option, or error path nobody asked for.",
  "Keep changes surgical: every changed line traces to the request, surrounding style is matched, and only orphans the change itself created are removed.",
  "Turn the task into a check that can be run, then loop until that check passes.",
]);
