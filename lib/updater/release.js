// dsh-tasks-manager — which release stream this updater follows.
//
// The identity of the tracked package plus the mapping from the plugin config
// to the settings the endpoints read. `profile` stays empty when it is not
// configured, so the endpoints derive the profile name from the profile
// directory they actually read.
// @module dsh-tasks-manager/updater/release

import { normalizeRepository } from "./tags.js";

/** The package this updater keeps current. */
export const PACKAGE_NAME = "dsh-tasks-manager";

/** Where its releases are published. */
export const DEFAULT_REPOSITORY = "necos98/dsh-tasks-manager";

/**
 * The updater's own settings, mapped from the resolved plugin config.
 * @param {object} config - the resolved plugin config.
 * @returns {{repository:string,packageName:string,profile:string,includePrerelease:boolean,timeoutMs:number,token:string}}
 */
export function updaterSettings(config) {
  const repository = normalizeRepository(config.updateRepository);
  return {
    repository: repository === "" ? DEFAULT_REPOSITORY : repository,
    packageName: PACKAGE_NAME,
    profile: typeof config.updateProfile === "string" ? config.updateProfile.trim() : "",
    includePrerelease: config.updateIncludePrerelease === true,
    timeoutMs: typeof config.updateTimeoutMs === "number" ? config.updateTimeoutMs : 180000,
    token: typeof config.updateToken === "string" ? config.updateToken : "",
  };
}
