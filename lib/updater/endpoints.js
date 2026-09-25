// dsh-tasks-manager — the three updater endpoints.
//
// The answer is always a value, never a rejection: the page renders this
// answer, and a lookup that failed is a state it has to show rather than an
// exception it has to catch. Installs run through a promise queue, so two
// browser tabs can never start two package managers at the same time.
// @module dsh-tasks-manager/updater/endpoints

import { basename } from "node:path";
import { messageOf, outputTail, runInstall } from "./command.js";
import { installSpecFor, isLinkedInstall, readInstalledVersion } from "./profile.js";
import { fetchRemoteTags, readTags } from "./tags.js";
import { isNewer, parseTag, pickLatest } from "./version.js";

/** Every endpoint also reads the tags the same way. */
function tagOptions(settings) {
  return { repository: settings.repository, token: settings.token, timeoutMs: settings.timeoutMs };
}

function answer(value) {
  return { ok: true, value };
}

function failure(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

function noReleaseMessage(repository) {
  return "no release tag in " + repository + " yet: bump package.json and push a tag " +
    "(git tag vX.Y.Z && git push origin vX.Y.Z)";
}

/**
 * The state of the machine, with no network and no shell: what is installed,
 * where the profile is, and whether that copy is a local link.
 * @param {object} ctx - the shared endpoint context (see {@link createUpdater}).
 * @returns {{ok:true,value:object}}
 */
function updateStatusOf(ctx) {
  const { current } = ctx.readCurrent();
  return answer({
    repository: ctx.settings.repository,
    profile: ctx.profileName(),
    profileDir: ctx.profileDir,
    packageName: ctx.settings.packageName,
    installed: current !== null,
    current,
    linked: ctx.linkedNow(),
    channel: ctx.settings.includePrerelease ? "prerelease" : "stable",
  });
}

/**
 * Compare the installed version with the newest released tag.
 * @param {object} ctx
 * @returns {Promise<{ok:true,value:object}>}
 */
async function checkUpdateOf(ctx) {
  const notes = [];
  const { current, note } = ctx.readCurrent();
  if (note !== null) notes.push(note);
  if (ctx.profileDir === null) {
    return answer({
      status: "error",
      current,
      latest: null,
      source: null,
      notes: [...notes, ctx.profileError],
      error: { code: "internal", message: ctx.profileError },
    });
  }
  const found = await readTags(ctx.fetchTags, tagOptions(ctx.settings));
  if (!found.ok) {
    return answer({
      status: "error",
      current,
      latest: null,
      source: null,
      notes: [...notes, found.message],
      error: { code: "internal", message: found.message },
    });
  }
  const source = found.remote.source;
  const tags = found.remote.tags;
  if (source === "api") notes.push("tags read through the GitHub API: `git ls-remote` was unavailable");
  if (!ctx.settings.includePrerelease) {
    const skipped = tags.filter((tag) => {
      const parsed = parseTag(tag);
      return parsed !== undefined && parsed.prerelease !== "";
    }).length;
    if (skipped > 0) notes.push(skipped + " prerelease tag(s) ignored while updateIncludePrerelease is false");
  }
  // The newest tag is re-read on every check: a page left open must never pin
  // an older release.
  const latest = pickLatest(tags, { includePrerelease: ctx.settings.includePrerelease });
  if (latest === undefined) {
    notes.push(noReleaseMessage(ctx.settings.repository));
    return answer({ status: "no-release", current, latest: null, source, notes });
  }
  if (current === null) return answer({ status: "not-installed", current, latest, source, notes });
  if (parseTag(current) === undefined) {
    notes.push('the installed version "' + current + '" is not a release version: treating it as older than ' + latest);
    return answer({ status: "update-available", current, latest, source, notes });
  }
  return answer({
    status: isNewer(latest, current) ? "update-available" : "up-to-date",
    current,
    latest,
    source,
    notes,
  });
}

/**
 * Install the newest release. The order of the refusals is the safety of this
 * endpoint: an unknown profile, a linked install and a profile name that does
 * not match the directory all stop BEFORE anything is written, and the tag is
 * re-read before the install so a stale page cannot pin an older release.
 * @param {object} ctx
 * @param {object} payload - `{ force?: boolean }`.
 * @returns {Promise<{ok:boolean,value?:object,error?:object}>}
 */
async function applyUpdateOf(ctx, payload) {
  const { settings } = ctx;
  if (ctx.profileDir === null) return failure("internal", ctx.profileError);
  if (ctx.linkedNow()) {
    return failure("internal", "installed from a local link (" + ctx.profileDir + "): update it in its own checkout");
  }
  // `dsh plugin --profile <profile>` resolves the profile from DSH_HOME, not
  // from the directory it runs in: when the two disagree the install would land
  // in a profile other than the one the installed version is read from.
  if (settings.profile !== "" && basename(ctx.profileDir).toLowerCase() !== settings.profile.toLowerCase()) {
    return failure(
      "internal",
      'updateProfile is "' + settings.profile + '" but the profile directory is "' + ctx.profileDir +
        '": fix `updateProfile` or `updateProfileDir`.',
    );
  }
  const force = payload !== null && typeof payload === "object" && payload.force === true;
  const before = ctx.readCurrent().current;
  const found = await readTags(ctx.fetchTags, tagOptions(settings));
  if (!found.ok) return failure("internal", found.message);
  const latest = pickLatest(found.remote.tags, { includePrerelease: settings.includePrerelease });
  if (latest === undefined) return failure("internal", noReleaseMessage(settings.repository));
  if (before !== null && !force && !isNewer(latest, before)) {
    return failure(
      "bad-request",
      "nothing to update: " + settings.packageName + "@" + before + " is already the newest release (" + latest +
        "). Pass { force: true } to reinstall it.",
    );
  }
  const installSpec = installSpecFor(settings.repository, latest);
  const result = await ctx.runInstall({
    profileDir: ctx.profileDir,
    spec: installSpec,
    profile: ctx.profileName(),
    timeoutMs: settings.timeoutMs,
  });
  if (result.status !== 0) {
    return failure(
      "internal",
      result.method + " could not install " + installSpec + " in " + ctx.profileDir + " (exit " + result.status +
        "):\n" + outputTail(result.output),
    );
  }
  let after = null;
  try {
    after = ctx.readVersion(ctx.profileDir, settings.packageName);
  } catch {
    after = null;
  }
  return answer({
    updated: after !== before,
    previous: before,
    current: after,
    latest,
    // A bundle's patch layer composes at boot: the new version is on disk and
    // not in the running process.
    restartRequired: true,
    installSpec,
    output: outputTail(result.output, 40),
  });
}

/**
 * The updater as one function the web host mounts into its RPC channel.
 * @param {{settings:object,profileDir:string|null,profileError?:string,deps?:object}} options
 * @returns {(endpoint:string,payload?:object)=>Promise<{ok:boolean,value?:object,error?:object}>}
 */
export function createUpdater(options) {
  const settings = options.settings;
  const profileDir = options.profileDir === undefined ? null : options.profileDir;
  const deps = options.deps ?? {};
  let queue = Promise.resolve();

  const ctx = {
    settings,
    profileDir,
    profileError: options.profileError || "cannot locate the DSH profile directory",
    fetchTags: deps.fetchTags ?? fetchRemoteTags,
    runInstall: deps.runInstall ?? runInstall,
    readVersion: deps.readVersion ?? readInstalledVersion,
    profileName: () => (settings.profile !== "" ? settings.profile : profileDir === null ? "" : basename(profileDir)),
    linkedNow: () => profileDir !== null && (deps.isLinked ?? isLinkedInstall)(profileDir, settings.packageName) === true,
  };
  // A malformed installed manifest reads as "not installed, with a note"
  // rather than as an endpoint that throws at the page.
  ctx.readCurrent = () => {
    if (profileDir === null) return { current: null, note: null };
    try {
      return { current: ctx.readVersion(profileDir, settings.packageName), note: null };
    } catch (error) {
      return { current: null, note: "cannot read the installed version: " + messageOf(error) };
    }
  };

  return async function updater(endpoint, payload) {
    try {
      if (endpoint === "updateStatus") return updateStatusOf(ctx);
      if (endpoint === "checkUpdate") return await checkUpdateOf(ctx);
      if (endpoint === "applyUpdate") {
        const task = () => applyUpdateOf(ctx, payload);
        const run = queue.then(task, task);
        queue = run.then(() => {}, () => {});
        return await run;
      }
      return failure("internal", 'unknown updater method "' + endpoint + '"');
    } catch (error) {
      return failure("internal", messageOf(error));
    }
  };
}
