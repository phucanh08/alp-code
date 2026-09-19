"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseHeader } = require("../src/parser");

test("empty input is a document with no header", () => {
  assert.deepEqual(parseHeader(""), { headers: {}, body: "" });
});

test("reads the header block and keeps the body", () => {
  assert.deepEqual(parseHeader("title: hello\nkind: note\n\nbody text"), {
    headers: { title: "hello", kind: "note" },
    body: "body text",
  });
});
