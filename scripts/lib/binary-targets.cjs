"use strict";

const os = require("node:os");
const { spawnSync } = require("node:child_process");

const TARGETS = Object.freeze(require("../../src/install/binary-targets.json").map(Object.freeze));

function resolveTarget(platform, arch, libc = null) {
  const normalizedLibc = platform === "linux" ? libc : null;
  const found = TARGETS.find((target) => target.platform === platform && target.arch === arch && target.libc === normalizedLibc);
  if (!found) throw new Error(`unsupported ALP binary target: ${platform}/${arch}${libc ? `/${libc}` : ""}`);
  return found;
}

function physicalDarwinArch() {
  const translated = spawnSync("sysctl", ["-in", "sysctl.proc_translated"], { encoding: "utf8" });
  return translated.status === 0 && translated.stdout.trim() === "1" ? "arm64" : os.arch();
}

function hostTarget() {
  const arch = process.platform === "darwin" ? physicalDarwinArch() : os.arch();
  const libc = process.platform === "linux"
    ? (process.report?.getReport?.().header?.glibcVersionRuntime ? "glibc" : "musl")
    : null;
  return resolveTarget(process.platform, arch, libc);
}

function archiveName(version, target) {
  if (!TARGETS.some((candidate) => candidate.id === target)) throw new Error(`unknown target: ${target}`);
  return `alp-code-v${version}-${target}.tar.gz`;
}

function byId(id) {
  const found = TARGETS.find((target) => target.id === id);
  if (!found) throw new Error(`unknown target: ${id}`);
  return found;
}

module.exports = { TARGETS, resolveTarget, hostTarget, archiveName, byId };
