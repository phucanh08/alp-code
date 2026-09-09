"use strict";

const fs = require("node:fs");
const path = require("node:path");

function definitions() {
  const installed = path.join(__dirname, "binary-targets.json");
  const development = path.resolve(__dirname, "..", "..", "src", "install", "binary-targets.json");
  return JSON.parse(fs.readFileSync(fs.existsSync(installed) ? installed : development, "utf8"));
}

function resolveTarget(platform = process.platform, arch = process.arch, report = process.report?.getReport()) {
  const libc = platform === "linux" ? (report?.header?.glibcVersionRuntime ? "glibc" : "musl") : null;
  const target = definitions().find((candidate) => candidate.platform === platform && candidate.arch === arch && candidate.libc === libc);
  if (!target) throw new Error(`unsupported ALP native target: ${platform}/${arch}${libc ? `/${libc}` : ""}`);
  return target;
}

function archiveName(version, target) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid wrapper version: ${version}`);
  if (!definitions().some((candidate) => candidate.id === target)) throw new Error(`unknown ALP target: ${target}`);
  return `alp-code-v${version}-${target}.tar.gz`;
}

module.exports = { definitions, resolveTarget, archiveName };
