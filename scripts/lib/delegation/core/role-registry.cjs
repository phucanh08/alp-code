const path = require("node:path");
const { UnknownRole } = require("./errors.cjs");

class RoleRegistry {
  constructor(repoRoot) { this.repoRoot = repoRoot; }

  definitions() {
    return require(path.join(this.repoRoot, "dist", "src", "agents", "registry.js")).agentRegistry;
  }

  get(role) {
    if (role === "principal") return { role: "principal", reports_to: null, delegates_to: ["main"] };
    const registry = this.definitions();
    if (!registry.has(role)) throw new UnknownRole(`Không có agent \`${role}\` trong compiled registry`);
    const definition = registry.get(role);
    return {
      role: definition.id,
      name: definition.displayName,
      reports_to: definition.reportsTo,
      delegates_to: [...definition.delegatesTo],
      tools: [...definition.capabilities.tools],
      memory: definition.capabilities.memory,
      workspaces: definition.capabilities.workspace,
      model: definition.model,
      reasoning_effort: definition.reasoningEffort,
    };
  }

  has(role) {
    try { this.get(role); return true; } catch (error) {
      if (error instanceof UnknownRole) return false;
      throw error;
    }
  }
}

module.exports = { RoleRegistry };
