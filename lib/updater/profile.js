// dsh-tasks-manager — the installed profile: where it is, what it declares,
// what it actually has.
//
// Everything here is filesystem work on the profile directory, and the updater
// never installs without it: a version read from the wrong directory is a
// report the user cannot act on. `ctx.baseUrl` is the composition root the
// loader mounted us from, which for a profile-bundled plugin IS the profile;
// the walk up from this module is the fallback when that does not hold.
// @module dsh-tasks-manager/updater/profile

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeRepository } from "./tags.js";

/** Version of one installed dependency, or null when the manifest is absent. */
export function readInstalledVersion(profileDir, packageName) {
  const path = join(profileDir, "node_modules", packageName, "package.json");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
  const manifest = JSON.parse(text);
  return typeof manifest.version === "string" && manifest.version !== "" ? manifest.version : null;
}

/** Whether one directory's package.json declares `dsh.profile`. */
function holdsProfileMarker(directory) {
  const manifestPath = join(directory, "package.json");
  if (!existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return manifest !== null && typeof manifest === "object" && manifest.dsh?.profile !== undefined;
  } catch {
    return false;
  }
}

function walkToProfile(start) {
  let directory = start;
  for (;;) {
    if (holdsProfileMarker(directory)) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * The profile directory this install belongs to. An explicit override wins;
 * otherwise `baseUrl` (the composition root the loader mounted us from) when it
 * carries a `package.json` with a `dsh.profile` key; otherwise the walk starts
 * at this module and climbs to the first ancestor that declares a profile.
 * @param {{baseUrl?:string,override?:string}} [options]
 * @returns {string} the absolute profile directory.
 * @throws {Error} when nothing declares a profile.
 */
export function resolveProfileDir(options = {}) {
  const configured = typeof options.override === "string" ? options.override.trim() : "";
  if (configured !== "") return resolve(configured);
  const starts = [];
  if (typeof options.baseUrl === "string" && options.baseUrl !== "") {
    try {
      const path = fileURLToPath(options.baseUrl);
      starts.push(existsSync(path) && !statSync(path).isDirectory() ? dirname(path) : path);
    } catch {
      // An unusable baseUrl is not the answer; the module walk still is.
    }
  }
  starts.push(dirname(fileURLToPath(import.meta.url)));
  for (const start of starts) {
    const found = walkToProfile(start);
    if (found !== undefined) return found;
  }
  throw new Error("cannot locate the DSH profile directory");
}

/** Whether the installed copy is a local link (`link:`) rather than a real tree. */
export function isLinkedInstall(profileDir, packageName) {
  const plain = join(profileDir, "node_modules", packageName);
  try {
    return realpathSync(plain) !== plain;
  } catch {
    return false;
  }
}

/** The spec that installs one exact release tag. */
export function installSpecFor(repository, tag) {
  return "github:" + normalizeRepository(repository) + "#" + tag;
}
