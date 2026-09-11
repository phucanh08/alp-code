import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentsDirectory,
  executionGraphsDirectory,
  executionsDirectory,
  hookForwarder,
  memoryRoot,
  stateHome,
} from "../../src/state-paths";

const requireCjs = createRequire(__filename);
const paths = requireCjs("../../scripts/lib/install-paths.cjs") as {
  stateHome(env: NodeJS.ProcessEnv): string;
  memoryRoot(env: NodeJS.ProcessEnv): string;
  agentsDir(env: NodeJS.ProcessEnv): string;
  executionsDir(env: NodeJS.ProcessEnv): string;
  executionGraphsDir(env: NodeJS.ProcessEnv): string;
  hookForwarderPath(name: string, env: NodeJS.ProcessEnv): string;
  detectChannel(root: string): string;
};

describe("state paths", () => {
  it("keeps user state out of the install directory", () => {
    const env = { HOME: "/home/a" } as NodeJS.ProcessEnv;
    expect(stateHome(env)).toBe(join("/home/a", ".alp"));
    expect(memoryRoot(env)).toBe(join("/home/a", ".alp", "memory"));
    expect(agentsDirectory(env)).toBe(join("/home/a", ".alp", "agents"));
    expect(executionsDirectory(env)).toBe(join("/home/a", ".alp", "executions"));
    expect(executionGraphsDirectory(env)).toBe(join("/home/a", ".alp", "execution-graphs"));
    expect(hookForwarder("session-boot", env)).toBe(join("/home/a", ".alp", "hooks", "session-boot.cjs"));
  });

  it("still lets ALP_MEMORY_ROOT and ALP_STATE_HOME override, for isolated runs", () => {
    expect(memoryRoot({ HOME: "/home/a", ALP_MEMORY_ROOT: "/tmp/m" } as NodeJS.ProcessEnv)).toBe(resolve("/tmp/m"));
    expect(stateHome({ HOME: "/home/a", ALP_STATE_HOME: "/tmp/s" } as NodeJS.ProcessEnv)).toBe(resolve("/tmp/s"));
    expect(memoryRoot({ HOME: "/home/a", ALP_STATE_HOME: "/tmp/s" } as NodeJS.ProcessEnv)).toBe(join(resolve("/tmp/s"), "memory"));
  });

  /**
   * Cùng bộ luật tồn tại hai bản: TypeScript cho runtime, CommonJS cho installer và script
   * bảo trì — chúng phải chạy được khi `dist/` chưa có hoặc đã hỏng. Hai bản trôi khỏi nhau
   * nghĩa là `alp` ghi memory một chỗ còn installer dựng và di trú ở chỗ khác, và không có
   * gì báo cho ai biết. Test này là thứ duy nhất giữ chúng dính vào nhau.
   */
  it("agrees with the CommonJS copy the installers use", () => {
    for (const env of [
      { HOME: "/home/a" },
      { USERPROFILE: "C:\\Users\\a" },
      { HOME: "/home/a", ALP_STATE_HOME: "/tmp/s" },
      { HOME: "/home/a", ALP_MEMORY_ROOT: "/tmp/m" },
    ] as NodeJS.ProcessEnv[]) {
      expect(stateHome(env)).toBe(paths.stateHome(env));
      expect(memoryRoot(env)).toBe(paths.memoryRoot(env));
      expect(agentsDirectory(env)).toBe(paths.agentsDir(env));
      expect(executionsDirectory(env)).toBe(paths.executionsDir(env));
      expect(executionGraphsDirectory(env)).toBe(paths.executionGraphsDir(env));
      expect(hookForwarder("session-boot", env)).toBe(paths.hookForwarderPath("session-boot", env));
    }
  });

  it("reads the install channel off the install directory itself", () => {
    // Cùng một cây file được `npm publish` và được nén vào tarball, nên nội dung không phân
    // biệt được hai bản cài — chỉ vị trí mới phân biệt được.
    expect(paths.detectChannel(join("/usr", "lib", "node_modules", "alp-code"))).toBe("npm");
    expect(paths.detectChannel(join("/home", "a", ".alp-code", "versions", "v0.9.0"))).toBe("tarball");
    expect(paths.detectChannel(resolve(__dirname, "..", ".."))).toBe("dev");
  });
});
