// dsh-tasks-manager — SQLite storage (pure: no ctx, no DSH imports).
// Conventions: node:sqlite DatabaseSync, WAL, application_id guard, user_version.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const APPLICATION_ID = 2003397999;
export const SCHEMA_VERSION = 2;

export function nowIso() { return new Date().toISOString(); }

function applySchema(db) {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA application_id = " + APPLICATION_ID);
  const row = db.prepare("PRAGMA user_version").get();
  const version = row ? row.user_version : 0;
  if (version !== 0 && version !== SCHEMA_VERSION) {
    if (version === 1) { migrateV1toV2(db); db.exec("PRAGMA user_version = 2"); }
    else throw new Error("tasks: unsupported schema " + version);
    return;
  }
  if (version === 0) { migrateV2(db); db.exec("PRAGMA user_version = 2"); }
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
