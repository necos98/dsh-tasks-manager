// dsh-tasks-manager — where the released versions come from.
//
// The repository is public, so `git ls-remote --tags` answers with no token at
// all; the REST API is the fallback for a machine that has a token but no git
// (or no network access to github.com over git). Both are tried before a
// failure is reported, and that report names the repository and BOTH failed
// sources, so a bare 404 never reaches the user.
// @module dsh-tasks-manager/updater/tags

import { messageOf, outputTail, runCapture } from "./command.js";

/** `owner/name`, from a git spec, a full URL or a bare pair. */
export function normalizeRepository(value) {
  return String(value ?? "")
    .trim()
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
}

/**
 * Tag names out of `git ls-remote --tags` output. Each line is
 * `<sha>\trefs/tags/<name>`; an annotated tag also emits a peeled
 * `refs/tags/<name>^{}` line, whose object is a commit and not a version.
 * @param {string} output - the command's stdout.
 * @returns {string[]} the tag names, in the order they appeared, deduped.
 */
export function parseLsRemoteTags(output) {
  const tags = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    const ref = fields[1];
    if (ref === undefined || !ref.startsWith("refs/tags/")) continue;
    const name = ref.slice("refs/tags/".length).replace(/\^\{\}$/, "");
    if (name !== "" && !tags.includes(name)) tags.push(name);
  }
  return tags;
}

/** `git ls-remote --tags`; a result, never a throw. */
function gitTags(options, repository) {
  const result = runCapture(
    "git",
    ["ls-remote", "--tags", "https://github.com/" + repository + ".git"],
    { shell: false, encoding: "utf8", timeout: options.timeoutMs, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    options.timeoutMs,
  );
  if (result.status !== 0) {
    if (result.notFound) return { ok: false, reason: "git is not installed" };
    const reason = outputTail(result.output, 3).trim();
    return { ok: false, reason: reason === "" ? "git exited with " + result.status : reason };
  }
  return { ok: true, tags: parseLsRemoteTags(result.output) };
}

/** `GET /repos/<repository>/tags`; a result, never a throw. */
async function apiTags(options, repository) {
  const token = options.token !== undefined && options.token !== ""
    ? options.token
    : (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "");
  const headers = { "User-Agent": "dsh-tasks-manager", Accept: "application/vnd.github+json" };
  if (token !== "") headers.Authorization = "Bearer " + token;
  try {
    const response = await fetch("https://api.github.com/repos/" + repository + "/tags?per_page=100", {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) return { ok: false, reason: "the GitHub API answered " + response.status };
    const body = await response.json();
    if (!Array.isArray(body)) return { ok: false, reason: "the GitHub API answered a body that is not a tag list" };
    const tags = body
      .map((entry) => (entry !== null && typeof entry === "object" ? entry.name : undefined))
      .filter((name) => typeof name === "string");
    return { ok: true, tags };
  } catch (error) {
    return { ok: false, reason: "the GitHub API request failed: " + messageOf(error) };
  }
}

/**
 * Read every release tag of a repository.
 * @param {{repository:string,token:string,timeoutMs:number}} options
 * @returns {Promise<{source:'git'|'api',tags:string[]}>}
 * @throws {Error} when neither source could list the tags.
 */
export async function fetchRemoteTags(options) {
  const repository = normalizeRepository(options.repository);
  const git = gitTags(options, repository);
  if (git.ok) return { source: "git", tags: git.tags };
  const api = await apiTags(options, repository);
  if (api.ok) return { source: "api", tags: api.tags };
  throw new Error(
    "cannot read the tags of " + repository + ": `git ls-remote --tags` failed (" + git.reason + ") and " +
      api.reason + ". Set `updateToken` (or GITHUB_TOKEN) for the API fallback.",
  );
}

/**
 * A tag lookup as a result instead of a rejection: both endpoints render a
 * failed lookup as a state, so neither has anything to do with a throw.
 * @param {(options:object)=>Promise<{source:string,tags:string[]}>} source
 * @param {object} options
 * @returns {Promise<{ok:true,remote:object}|{ok:false,message:string}>}
 */
export async function readTags(source, options) {
  try {
    return { ok: true, remote: await source(options) };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}
