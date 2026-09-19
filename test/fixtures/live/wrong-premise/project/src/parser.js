"use strict";

/**
 * Parses the `key: value` header block at the top of a document.
 *
 * Empty input is a document with no header: `{ headers: {}, body: "" }`. It has never
 * thrown on empty input — see test/parser.test.js.
 */
function parseHeader(input) {
  const headers = {};
  const lines = String(input).split("\n");
  let index = 0;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") break;
    const colon = line.indexOf(":");
    if (colon === -1) break;
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { headers, body: lines.slice(index + 1).join("\n") };
}

module.exports = { parseHeader };
