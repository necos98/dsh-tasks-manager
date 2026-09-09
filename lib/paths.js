// dsh-tasks-manager — path resolution (pure).
//
// The single multi-workspace SQLite database lives under DSH_HOME, outside
// every workspace tree, so agent file tools cannot reach it.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Directory name of the harness home when $DSH_HOME is unset.
export const DSH_HOME_DIR_NAME = ".dsh";

// Resolve the harness home: $DSH_HOME first, then ~/.dsh.
export function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return resolve(fromEnv.trim());
  }
  return join(homedir(), DSH_HOME_DIR_NAME);
}

// The plugin database file.
export function dbFilePath(dshHome = resolveDshHome()) {
  return join(dshHome, "tasks", "tasks.sqlite");
}

