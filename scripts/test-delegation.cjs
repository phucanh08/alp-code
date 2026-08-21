#!/usr/bin/env node
const assert = require("assert");
const { wrapDelegatedPrompt } = require("./lib/delegation.cjs");

const prompt = wrapDelegatedPrompt("Tìm luồng authentication");
assert(prompt.includes("do `main` (Phở 🍜) giao"));
assert(prompt.includes("chỉ gửi về `main`"));
assert(prompt.includes("không giao tiếp trực tiếp với principal"));
assert(prompt.endsWith("Tìm luồng authentication"));
console.log("OK               delegation prompt tests passed");
