const L = require("../../loadout.cjs");
const { UnknownRole } = require("./errors.cjs");

class RoleRegistry {
  constructor(repoRoot) { this.repoRoot = repoRoot; }

  get(role) {
    if (role === "principal") return { role: "principal", reports_to: null, delegates_to: ["main"] };
    const loadout = L.loadLoadout(this.repoRoot, role);
    if (!loadout) throw new UnknownRole(`Không có role \`${role}\` trong identity/`);
    return { ...loadout, role };
  }

  has(role) {
    try { this.get(role); return true; } catch (error) {
      if (error instanceof UnknownRole) return false;
      throw error;
    }
  }
}

module.exports = { RoleRegistry };
