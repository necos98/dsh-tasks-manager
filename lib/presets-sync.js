// dsh-tasks-manager — preset sync (pure: node:fs only).
//
// DSH discovers agent presets from fixed roots (the shipped set inside
// dsh-agent-presets plus $DSH_HOME/.agent-presets); it never scans third-party
// plugin directories. So at startup this plugin copies its own
// presets/taskqueue-* compositions into the user root, ALWAYS overwriting:
// the plugin source is the single authority, and any hand edit in the
// installed copy is discarded on the next boot.
import { chmodSync, cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Preset ids this plugin ships (directories under presets/).
export const PRESET_IDS = ["taskqueue-intake", "taskqueue-worker"];

// Harness-home directory holding locally authored presets (same spelling as
// dsh-agent-presets' own user root: <dshHome>/.agent-presets).
export const USER_PRESET_DIR = ".agent-presets";

// presets/ beside this package's lib/ (the same pattern dsh-agent-presets uses
// for its own shipped root: resolved from import.meta.url, so it works from a
// checkout and from an installed package alike).
export function pluginPresetsRoot() {
  return fileURLToPath(new URL("../presets/", import.meta.url));
}

export function userPresetRoot(dshHome) {
  return join(dshHome, USER_PRESET_DIR);
}

// Owner-only copy, mirroring the roster's own tightenModes for authored
// presets (a preset IS a composition, same weight as settings). Best-effort:
// Windows has no POSIX owner-execute bit and a half-chmodded tree still mounts.
function tightenModes(dir) {
  try {
    chmodSync(dir, 0o700);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const target = join(dir, entry.name);
      if (entry.isDirectory()) {
        tightenModes(target);
      } else {
        try {
          const st = statSync(target);
          chmodSync(target, (st.mode & 0o100) === 0 ? 0o600 : 0o700);
        } catch { /* keep going */ }
      }
    }
  } catch { /* keep going */ }
}

// Copy every shipped preset into the user root, always overwriting. Never
// throws as a whole: a broken row reports { status: "failed" } while healthy
// rows still sync.
export function syncPluginPresets({ sourceRoot, userRoot }) {
  const outcomes = [];
  mkdirSync(userRoot, { recursive: true });
  for (const id of PRESET_IDS) {
    const sourceDir = join(sourceRoot, id);
    const destDir = join(userRoot, id);
    try {
      let existed = false;
      try {
        existed = statSync(destDir).isDirectory();
      } catch {
        existed = false;
      }
      rmSync(destDir, { recursive: true, force: true });
      // dereference:true like the roster copy: the install is self-contained,
      // never a set of links back into the plugin directory.
      cpSync(sourceDir, destDir, { recursive: true, dereference: true, force: false, errorOnExist: true });
      tightenModes(destDir);
      outcomes.push({ id, status: existed ? "updated" : "created", path: destDir });
    } catch (err) {
      outcomes.push({ id, status: "failed", path: destDir, error: err && err.message ? err.message : String(err) });
    }
  }
  return outcomes;
}
