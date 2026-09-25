// dsh-tasks-manager — manual GitHub updater (public entry).
//
// The Settings → Tasks page asks three questions and never talks to GitHub
// itself:
//
//   updateStatus — what is on disk right now (no network, no shell).
//   checkUpdate  — is the installed version the newest RELEASE TAG of the
//                  repository (tags only, never a branch head).
//   applyUpdate  — install the newest release into the profile.
//
// This file is the façade the host and the tests import; the domain lives in
// `lib/updater/`, one responsibility per file:
//
//   version.js   — what "newer" means (pure semver arithmetic over tags)
//   tags.js      — where the released tags come from (git, then the API)
//   profile.js   — which profile is installed and where it lives
//   command.js   — the machine boundary: one command, run
//   release.js   — which release stream this updater follows (settings)
//   endpoints.js — the three answers, installs serialized
//
// Everything that touches the machine is injectable through
// `createUpdater({ deps })`, so the decision layer is testable without a
// network, a shell or a DSH boot.
// @module dsh-tasks-manager/updater

export { PACKAGE_NAME, DEFAULT_REPOSITORY, updaterSettings } from "./updater/release.js";
export { isNewer, parseTag, pickLatest } from "./updater/version.js";
export { fetchRemoteTags, normalizeRepository, parseLsRemoteTags, readTags } from "./updater/tags.js";
export { installSpecFor, isLinkedInstall, readInstalledVersion, resolveProfileDir } from "./updater/profile.js";
export { runInstall } from "./updater/command.js";
export { createUpdater } from "./updater/endpoints.js";
