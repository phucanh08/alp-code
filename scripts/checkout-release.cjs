#!/usr/bin/env node
// checkout-release.cjs — installers call this right after cloning (and `alp update` runs the
// same logic through scripts/lib/update.cjs) to land the working tree on the latest GitHub
// Release tag, or on --version <tag> when pinned.

const path = require("path");
const { checkoutLatestRelease } = require("./lib/update.cjs");

const repoRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
let pinTag;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--version") {
    pinTag = args[++index];
    if (!pinTag) { console.error("ERROR    --version requires a tag"); process.exit(1); }
  }
}

checkoutLatestRelease(repoRoot, {
  env: process.env,
  stdio: "inherit",
  pinTag,
  log(level, message) { console.log(`${level.padEnd(9)}${message}`); },
}).then(
  (result) => {
    if (!result.ok) { console.error(`ERROR    ${result.message}`); process.exit(1); }
    console.log(`READY    checked out ${result.tag}`);
  },
  (error) => { console.error(`ERROR    ${error.message}`); process.exit(1); },
);
