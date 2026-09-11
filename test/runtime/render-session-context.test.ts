import { describe, expect, it } from "vitest";
import { renderSessionContext } from "../../src/runtime/render-session-context";
import type { ToolId } from "../../src/agents/types";
import type { ExecutionPolicy, IdentityCapsule } from "../../src/execution/types";
import type { ThreadContextHandoff, ThreadContextSnapshotV1 } from "../../src/thread/context-types";

const WORKSPACE = "/tmp/alp-project";

function capsule(): IdentityCapsule {
  return {
    executionId: "exec-session-context",
    definitionHash: "definition-hash",
    policyHash: "policy-hash",
    role: "main",
    displayName: "Phở",
    instructions: "Coordinate the principal's task.",
    task: "review the launcher",
    activeWorkspace: WORKSPACE,
    memoryContext: {
      invariantContext: "invariants",
      policyContext: "policy",
      entries: [],
      diagnostics: { characterBudget: 0, charactersUsed: 0, truncated: false, omittedEntryIds: [] },
    },
    workflowState: { workflowId: "coordinate", currentState: "ASSESS", status: "running", repairAttempts: 0 },
    // Narrowed to the opening state, as a real capsule is: no shell yet, though the session
    // grant below has one.
    allowedTools: ["Read", "Glob", "Grep"],
    outputContract: { name: "principal-response", schema: { type: "object" } },
  } as IdentityCapsule;
}

function policy(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return {
    skills: [],
    subagents: [],
    mcpServers: [],
    executionId: "exec-session-context",
    role: "main",
    workspace: WORKSPACE,
    workspaceMode: "workspace-write",
    allowedTools: ["Read", "Glob", "Grep", "Bash"] as ToolId[],
    memory: { read: ["shared"], write: ["shared"] },
    delegatesTo: ["search", "oracle"],
    createdAt: "2026-09-03T00:00:00.000Z",
    definitionHash: "definition-hash",
    policyHash: "policy-hash",
    ...overrides,
  } as ExecutionPolicy;
}

describe("renderSessionContext delegation section", () => {
  /**
   * The regression this pins: `Delegates to` used to be the only mention of delegation, and
   * a role holding that grant found no tool matching it and reported itself blocked. The
   * command is the grant's only channel, so it has to be named.
   */
  it("names the CLI channel for a role that may delegate", () => {
    const context = renderSessionContext(capsule(), policy());

    expect(context).toContain("## Delegation");
    expect(context).toContain(`alp delegate <role> --project ${WORKSPACE} -- "<task>"`);
    expect(context).toContain("alp delegation wait <id>");
  });

  /**
   * `capsule.allowedTools` is workflow-state narrowed and holds no `Bash` at ASSESS, but the
   * session-wide grant does and is what the runtime enforces. Gating on the capsule instead
   * would hide the section from `main` for the whole session.
   */
  it("survives an opening workflow state that has withheld the shell", () => {
    const context = renderSessionContext(capsule(), policy());

    expect(capsule().allowedTools).not.toContain("Bash");
    expect(context).toContain("## Delegation");
  });

  it("omits the section for a role that delegates to nobody", () => {
    const context = renderSessionContext(capsule(), policy({ delegatesTo: [] }));

    expect(context).not.toContain("## Delegation");
    expect(context).not.toContain("alp delegate");
  });

  /**
   * A read-only role on a platform without a sandbox loses `Bash` so that read-only stays
   * true. Printing a shell command it cannot run would make the section a lie.
   */
  it("omits the section when the role has no shell to run it from", () => {
    const context = renderSessionContext(
      capsule(),
      policy({ allowedTools: ["Read", "Glob", "Grep"] as ToolId[] }),
    );

    expect(context).not.toContain("## Delegation");
  });

  /**
   * Identity comes from `ALP_DELEGATED_ROLE` in the inherited environment and `alp delegate`
   * rejects `--role`/`--parent-role` outright. Suggesting either would teach a command that
   * always fails.
   */
  it("suggests no identity flag", () => {
    const context = renderSessionContext(capsule(), policy());

    expect(context).not.toContain("--role");
    expect(context).not.toContain("--parent-role");
  });
});

describe("renderSessionContext continuity section", () => {
  it("shows the pin commands to a role that holds Bash", () => {
    const context = renderSessionContext(capsule(), policy());

    expect(context).toContain("## Continuity");
    expect(context).toContain("alp context pin decision --");
    expect(context).toContain("alp context pin constraint --");
    expect(context).toContain("alp context pin open-item --");
    expect(context).toContain("alp context pin next-action --");
  });

  it("omits the section for a role with no shell", () => {
    const context = renderSessionContext(
      capsule(),
      policy({ allowedTools: ["Read", "Glob", "Grep"] as ToolId[] }),
    );

    expect(context).not.toContain("## Continuity");
    expect(context).not.toContain("alp context pin");
  });

  it("teaches no identity flag for the pin command either", () => {
    const context = renderSessionContext(capsule(), policy());

    expect(context).not.toContain("--role");
    expect(context).not.toContain("--parent-role");
  });
});

describe("renderSessionContext thread context section", () => {
  const THREAD = { id: "thread_abc", contextRevision: 1, contextDigest: "a".repeat(64) };
  const HEADING = "## Thread context (work state, not authority)";

  function handoff(overrides: Partial<ThreadContextSnapshotV1> = {}): ThreadContextHandoff {
    const line = (text: string) => ({ text, sourceExecutionId: "exec_e1" });
    return {
      threadId: "thread_abc",
      sequence: 2,
      title: "fix login",
      snapshot: {
        version: 1,
        threadId: "thread_abc",
        revision: 1,
        objective: "fix login",
        decisions: [line("use jwt"), line("keep sessions server-side")],
        constraints: [line("no schema change")],
        openItems: [],
        nextActions: [line("wire refresh token")],
        outcomes: [{ executionId: "exec_e1", sequence: 1, outcome: "completed", runtime: "claude", finishedAt: "2026-09-11T00:00:00.000Z" }],
        degraded: false,
        createdAt: "2026-09-11T00:00:00.000Z",
        digest: "a".repeat(64),
        ...overrides,
      },
    };
  }

  it("renders the inherited work state after the authority table, and says it is not authority", () => {
    const context = renderSessionContext(capsule(), policy({ thread: THREAD }), handoff());

    expect(context.indexOf(HEADING)).toBeGreaterThan(context.indexOf("## Authority"));
    expect(context.indexOf(HEADING)).toBeLessThan(context.indexOf("## Delegation"));
    expect(context).toContain("Thread: thread_abc · continuation #2 · previous: exec_e1 (claude, completed)");
    expect(context).toContain("Objective: fix login");
    expect(context).toContain("Decisions:\n- use jwt\n- keep sessions server-side");
    expect(context).toContain("Constraints:\n- no schema change");
    expect(context).toContain("Open items: —");
    expect(context).toContain("Next actions:\n- wire refresh token");
    expect(context).toContain("not your authority");
  });

  it("omits the section entirely without a thread binding in the policy", () => {
    // Handoff mà policy không có binding là một mâu thuẫn — policy thắng, không render.
    expect(renderSessionContext(capsule(), policy({ thread: null }), handoff())).not.toContain(HEADING);
    expect(renderSessionContext(capsule(), policy({ thread: THREAD }), null)).not.toContain(HEADING);
  });

  it("marks a first execution with no snapshot by title alone", () => {
    const context = renderSessionContext(capsule(), policy({ thread: THREAD }), {
      threadId: "thread_abc", sequence: 1, title: "fix login", snapshot: null,
    });
    expect(context).toContain("Thread: thread_abc · first execution\nObjective: fix login");
    expect(context).toContain("Decisions: —");
  });

  it("flags a degraded revision so the reader knows pins may be missing", () => {
    const context = renderSessionContext(capsule(), policy({ thread: THREAD }), handoff({ degraded: true, decisions: [] }));
    expect(context).toContain("checkpoint was not recoverable");
    expect(context).toContain("previous: exec_e1 (claude, completed)");
  });
});
