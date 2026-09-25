// dsh-tasks-manager — release tags: what "newer" means for this updater.
//
// Pure and dependency-free on purpose: this is the only part that decides
// whether the installed copy is behind, so it is the part that has to be
// cheap to test exhaustively. Tags come from `git ls-remote` (annotated,
// `vX.Y.Z`) or from the GitHub API (the same names), so the parser accepts the
// `v` prefix and, beyond a plain three-field version, only a prerelease.
//
// The rules are the semver precedence rules restricted to what this plugin
// publishes: numeric field comparison, and a prerelease lower than its release
// with identifier-wise ordering inside it.
// @module dsh-tasks-manager/updater/version

const TAG_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Parse one tag or version string.
 * @param {string} name - the candidate, with or without the leading `v`.
 * @returns {{raw:string,major:number,minor:number,patch:number,prerelease:string}|undefined}
 */
export function parseTag(name) {
  const raw = String(name ?? "").trim();
  const match = TAG_RE.exec(raw);
  if (match === null) return undefined;
  return {
    raw,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? "" : match[4],
  };
}

function compareIdentifier(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function comparePrerelease(left, right) {
  const a = left === "" ? [] : left.split(".");
  const b = right === "" ? [] : right.split(".");
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    const delta = compareIdentifier(a[index], b[index]);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

function compareParsed(a, b) {
  for (const field of ["major", "minor", "patch"]) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  if (a.prerelease === "" && b.prerelease === "") return 0;
  if (a.prerelease === "") return 1;
  if (b.prerelease === "") return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Whether `latest` is strictly newer than `current`. Unparseable input is never
 * newer: every caller has already filtered with {@link parseTag}, and inventing
 * an order for a value that is not a version would turn a broken tag into an
 * update offer.
 * @param {string} latest
 * @param {string} current
 * @returns {boolean}
 */
export function isNewer(latest, current) {
  const a = parseTag(latest);
  const b = parseTag(current);
  if (a === undefined || b === undefined) return false;
  return compareParsed(a, b) > 0;
}

/**
 * The newest release tag among `tags`, returned as PUBLISHED (the `v` prefix
 * kept exactly as the tag spells it). Unparseable tags are ignored.
 * @param {string[]} tags - tag names.
 * @param {{includePrerelease?:boolean}} [options] - prereleases are skipped by default.
 * @returns {string|undefined}
 */
export function pickLatest(tags, options = {}) {
  const includePrerelease = options.includePrerelease === true;
  let best;
  for (const tag of Array.isArray(tags) ? tags : []) {
    const parsed = parseTag(tag);
    if (parsed === undefined) continue;
    if (!includePrerelease && parsed.prerelease !== "") continue;
    if (best === undefined || compareParsed(parsed, best) > 0) best = parsed;
  }
  return best === undefined ? undefined : best.raw;
}
