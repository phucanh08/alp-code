import { describe, expect, it } from "vitest";
import { hookInvocation, renderHookCommand } from "../../src/runtime/hook-command";

describe("hook command renderer", () => {
  it("keeps executable and argv separate until platform rendering", () => {
    expect(hookInvocation("/Applications/ALP Code/bin/alp", "compact-record", ["pre", "claude"])).toEqual({
      executable: "/Applications/ALP Code/bin/alp",
      args: ["hook", "compact-record", "pre", "claude"],
    });
  });

  it("quotes stable absolute paths safely on POSIX and Claude Windows", () => {
    const invocation = hookInvocation("/Users/A Name/alp", "session-boot");
    expect(renderHookCommand(invocation, { platform: "darwin", runtime: "claude" }))
      .toBe("'/Users/A Name/alp' 'hook' 'session-boot'");
    expect(renderHookCommand(hookInvocation("C:\\Users\\A Name\\alp.exe", "session-boot"), { platform: "win32", runtime: "claude" }))
      .toBe('"C:\\Users\\A Name\\alp.exe" hook session-boot');
  });

  it("uses the measured bare stable command for Codex Windows", () => {
    expect(renderHookCommand(hookInvocation("C:\\Users\\A Name\\alp.exe", "session-boot"), {
      platform: "win32",
      runtime: "codex",
      windowsPathCommand: "alp",
    })).toBe("alp hook session-boot");
  });
});
