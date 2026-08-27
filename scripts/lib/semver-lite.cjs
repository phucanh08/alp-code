// Minimal vX.Y.Z / X.Y.Z parsing and comparison — no pre-release/build-metadata support,
// which is all alp-code's release tags need.

function parse(tag) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag).trim());
  return match && { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compare(a, b) {
  const parsedA = parse(a);
  const parsedB = parse(b);
  if (!parsedA || !parsedB) throw new Error(`invalid semver tag: ${JSON.stringify(!parsedA ? a : b)}`);
  return parsedA.major - parsedB.major || parsedA.minor - parsedB.minor || parsedA.patch - parsedB.patch;
}

function isValid(tag) {
  return parse(tag) !== null;
}

module.exports = { parse, compare, isValid };
