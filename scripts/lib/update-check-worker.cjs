#!/usr/bin/env node
// Detached child entrypoint for the background "is there a newer release" check. Spawned by
// src/cli/update-check.ts with stdio:"ignore" and unref()'d — this process outlives the `alp`
// invocation that spawned it and must never throw uncaught or hang the caller.
"use strict";

const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..");
const { resolveLatestReleaseTag } = require("./update.cjs");
const { FileUpdateCheckStore } = require(path.join(repoRoot, "dist", "src", "cli", "update-check.js"));

process.on("unhandledRejection", () => process.exit(0));

(async () => {
  const resolved = await resolveLatestReleaseTag(repoRoot, { timeoutMs: 4000 }).catch(() => ({ ok: false }));
  await new FileUpdateCheckStore()
    .write({ checkedAt: Date.now(), latestTag: resolved.ok ? resolved.tag : null })
    .catch(() => {});
  process.exit(0);
})();
