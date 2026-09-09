// dsh-tasks-manager — SQLite storage (pure: no ctx, no DSH imports).
// Conventions: node:sqlite DatabaseSync, WAL, application_id guard, user_version.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const APPLICATION_ID = 2003397999;
export const SCHEMA_VERSION = 4;

export function nowIso() { return new Date().toISOString(); }

function applySchema(db) {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA application_id = " + APPLICATION_ID);
  const row = db.prepare("PRAGMA user_version").get();
  const version = row ? row.user_version : 0;
  if (version !== 0 && version !== SCHEMA_VERSION) {
    if (version === 1) { migrateV1toV2(db); migrateV2toV3(db); migrateV3toV4(db); db.exec("PRAGMA user_version = 4"); }
    else if (version === 2) { migrateV2toV3(db); migrateV3toV4(db); db.exec("PRAGMA user_version = 4"); }
    else if (version === 3) { migrateV3toV4(db); db.exec("PRAGMA user_version = 4"); }
    else throw new Error("tasks: unsupported schema " + version);
    return;
  }
  if (version === 0) { migrateV3(db); db.exec("PRAGMA user_version = 4"); }
}

// v2 renames tipo->type, titolo->title, stato->state (all English).
// Fresh installs create v2 directly; v1 databases migrate in place.
function migrateV1toV2(db) {
  db.exec("ALTER TABLE tasks RENAME COLUMN tipo TO type");
  db.exec("ALTER TABLE tasks RENAME COLUMN titolo TO title");
  db.exec("ALTER TABLE tasks RENAME COLUMN stato TO state");
  db.exec("DROP INDEX IF EXISTS idx_tasks_ws_stato");
  db.exec("CREATE INDEX idx_tasks_ws_state ON tasks(workspace_id, state)");
}

function migrateV1(db) {
  db.exec("CREATE TABLE workspaces (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, base_branch TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, tipo TEXT NOT NULL, titolo TEXT NOT NULL, slug TEXT NOT NULL, spec TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL, stato TEXT NOT NULL DEFAULT 'draft', worker_session TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT, close_reason TEXT)");
  db.exec("CREATE INDEX idx_tasks_ws_stato ON tasks(workspace_id, stato)");
  migrateV1toV2(db);
}

function migrateV2(db) {
  db.exec("CREATE TABLE workspaces (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, base_branch TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, type TEXT NOT NULL, title TEXT NOT NULL, slug TEXT NOT NULL, spec TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft', worker_session TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT, close_reason TEXT)");
  db.exec("CREATE INDEX idx_tasks_ws_state ON tasks(workspace_id, state)");
}

// v3 adds the per-workspace visible number: tasks.seq (1-based position of
// the task inside its workspace). The global INTEGER PRIMARY KEY id stays the
// internal stable row identity (FKs, worker_session binding, all mutations).
// Fresh installs create v3 directly; v1/v2 databases migrate in place with a
// deterministic backfill (id ASC order inside each workspace).
function migrateV2toV3(db) {
  db.exec("ALTER TABLE tasks ADD COLUMN seq INTEGER");
  db.exec("UPDATE tasks SET seq = (SELECT COUNT(*) FROM tasks t2 WHERE t2.workspace_id = tasks.workspace_id AND t2.id <= tasks.id)");
  // No row may survive without a number (the column was just backfilled).
  const missing = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE seq IS NULL").get();
  if (missing && missing.n !== 0) throw new Error("tasks: v3 migration left " + missing.n + " rows without seq");
  db.exec("CREATE UNIQUE INDEX idx_tasks_ws_seq ON tasks(workspace_id, seq)");
}

function migrateV3(db) {
  db.exec("CREATE TABLE workspaces (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, base_branch TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, seq INTEGER NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, slug TEXT NOT NULL, spec TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft', worker_session TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT, close_reason TEXT, queued_at TEXT)");
  db.exec("CREATE INDEX idx_tasks_ws_state ON tasks(workspace_id, state)");
  db.exec("CREATE UNIQUE INDEX idx_tasks_ws_seq ON tasks(workspace_id, seq)");
}

// v4 records WHEN a task was approved: tasks.queued_at (ISO timestamp set by
// approve()). FIFO promotion and queued listing order by queued_at ASC with
// id ASC as the tiebreaker (existing queued rows keep NULL and fall back to
// id order — acceptable). Fresh installs create v4 directly.
function migrateV3toV4(db) {
  db.exec("ALTER TABLE tasks ADD COLUMN queued_at TEXT");
}

export function openDatabase(options) {
  mkdirSync(dirname(options.path), { recursive: true });
  const db = new DatabaseSync(options.path);
  applySchema(db);
  return { db, close() { db.close(); } };
}

export function openMemory() {
  const db = new DatabaseSync(":memory:");
  applySchema(db);
  return { db, close() { db.close(); } };
}
