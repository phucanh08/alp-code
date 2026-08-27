import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkForUpdate, type UpdateCheckCache, type UpdateCheckStore } from "../../src/cli/update-check";

const repoRoot = resolve(__dirname, "../..");

function fakeStore(cache: UpdateCheckCache | null): UpdateCheckStore {
  return {
    async read() { return cache; },
    async write() { /* unused in these tests */ },
  };
}

describe("checkForUpdate", () => {
  it("triggers a background refresh and returns null when the cache is empty", async () => {
    const trigger = vi.fn();
    const notice = await checkForUpdate({
      repoRoot,
      store: fakeStore(null),
      currentVersion: "0.1.0",
      triggerBackgroundRefresh: trigger,
    });
    expect(notice).toBeNull();
    expect(trigger).toHaveBeenCalledWith(repoRoot);
  });

  it("returns a notice for a fresh cache with a newer tag, without refreshing", async () => {
    const trigger = vi.fn();
    const now = Date.now();
    const notice = await checkForUpdate({
      repoRoot,
      store: fakeStore({ checkedAt: now, latestTag: "v0.2.0" }),
      currentVersion: "0.1.0",
      now,
      triggerBackgroundRefresh: trigger,
    });
    expect(notice).toContain("v0.2.0");
    expect(trigger).not.toHaveBeenCalled();
  });

  it("returns null for a fresh cache with the same or an older tag", async () => {
    const now = Date.now();
    const notice = await checkForUpdate({
      repoRoot,
      store: fakeStore({ checkedAt: now, latestTag: "v0.1.0" }),
      currentVersion: "0.1.0",
      now,
      triggerBackgroundRefresh: vi.fn(),
    });
    expect(notice).toBeNull();
  });

  it("still reports the last-known newer tag from a stale cache, and triggers a refresh", async () => {
    const trigger = vi.fn();
    const now = Date.now();
    const staleCheckedAt = now - 25 * 60 * 60 * 1000;
    const notice = await checkForUpdate({
      repoRoot,
      store: fakeStore({ checkedAt: staleCheckedAt, latestTag: "v0.2.0" }),
      currentVersion: "0.1.0",
      now,
      triggerBackgroundRefresh: trigger,
    });
    expect(notice).toContain("v0.2.0");
    expect(trigger).toHaveBeenCalledWith(repoRoot);
  });
});
