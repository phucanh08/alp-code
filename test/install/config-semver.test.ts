import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDelegationConfig, parseConfig } from "../../src/install/config";
import { compareSemver, isValidSemver, parseSemver } from "../../src/install/semver";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeTemporary)));

describe("static install dependencies", () => {
  it("parses the supported delegation YAML subset", () => {
    expect(parseConfig("delegation:\n  state_dir: '/tmp/alp state'\n  enabled: true\n")).toEqual({
      delegation: { state_dir: "/tmp/alp state", enabled: true },
    });
    expect(() => parseConfig("- unsupported\n")).toThrow(/config/);
  });

  it("keeps installed delegation state stable across version roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-config-"));
    roots.push(root);
    await mkdir(join(root, "versions", "v1", "scaffold"), { recursive: true });
    await mkdir(join(root, "versions", "v2", "scaffold"), { recursive: true });
    const env = { HOME: join(root, "home") } as NodeJS.ProcessEnv;
    expect(loadDelegationConfig(join(root, "versions", "v1"), env, "binary").stateDir)
      .toBe(join(root, "home", ".alp", "delegation", "installed"));
    expect(loadDelegationConfig(join(root, "versions", "v2"), env, "binary").stateDir)
      .toBe(join(root, "home", ".alp", "delegation", "installed"));
  });

  it("ports the release semver behavior without prerelease ambiguity", () => {
    expect(parseSemver("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(compareSemver("1.2.3", "1.3.0")).toBeLessThan(0);
    expect(isValidSemver("1.2.3-beta.1")).toBe(false);
    expect(() => compareSemver("bad", "1.0.0")).toThrow(/invalid semver/);
  });
});
