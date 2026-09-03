export const CODE_NATIVE_HOUSE_RULES = Object.freeze([
  "Use ALP policy and delegation boundaries; never launch raw Herdr, Paseo, or in-process agents.",
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
