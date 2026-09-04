export type AgentRegistryErrorCode =
  | "DUPLICATE_AGENT"
  | "INVALID_AGENT"
  | "UNKNOWN_AGENT"
  | "UNKNOWN_RELATION"
  | "INVALID_DELEGATION"
  | "INVALID_MEMORY_GRANT"
  | "INVALID_WORKSPACE_GRANT"
  | "UNKNOWN_TOOL"
  | "UNKNOWN_SKILL"
  | "UNKNOWN_SUBAGENT"
  | "UNKNOWN_MCP_SERVER"
  | "INVALID_SKILL_GRANT"
  | "DUPLICATE_GRANT";

export class AgentRegistryError extends Error {
  readonly code: AgentRegistryErrorCode;

  constructor(code: AgentRegistryErrorCode, message: string) {
    super(message);
    this.name = "AgentRegistryError";
    this.code = code;
  }
}
