const { UnauthorizedDelegation } = require("./errors.cjs");

class DelegationPolicy {
  assertCanDelegate(parent, target) {
    const allowed = parent.delegates_to || [];
    if (!allowed.includes(target.role)) {
      throw new UnauthorizedDelegation(
        `DelegationDenied: \`${parent.role}\` không được delegate cho \`${target.role}\` ` +
          `(delegates_to: ${allowed.join(", ") || "[]"})`,
        { details: { parentRole: parent.role, targetRole: target.role } }
      );
    }

    if (target.reports_to && target.reports_to !== parent.role) {
      throw new UnauthorizedDelegation(
        `DelegationDenied: \`${target.role}\` reports_to \`${target.reports_to}\`, không phải \`${parent.role}\``
      );
    }
  }
}

module.exports = { DelegationPolicy };
