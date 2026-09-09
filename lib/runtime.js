// dsh-tasks-manager — shared plugin runtime (SQLite handle + registry).
// Used by the host entry (lib/index.js) and the scoped entries
// (lib/intake-tools.js, lib/worker-tools.js) alike.
import { openDatabase } from "./db.js";
import { dbFilePath, resolveDshHome } from "./paths.js";

export function createRuntime(resolved) {
  let handle = null;
  const runtime = {
    dbPath: resolved.dshHome ? dbFilePath(resolved.dshHome) : dbFilePath(resolveDshHome()),
    workspaceRegistry: undefined,
    getDb() { if (!handle) handle = openDatabase({ path: runtime.dbPath }); return handle.db; },
    closeDb() { if (handle) { handle.close(); handle = null; } },
  };
  return runtime;
}
