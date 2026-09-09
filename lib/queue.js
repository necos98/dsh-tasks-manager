// dsh-tasks-manager — queue domain: the stupid deterministic core (pure).
// States: draft -> queued -> active -> done|cancelled|failed.
// Rules: approve always goes to queued; promotion is FIFO when no active;
// close is user-only and frees the slot. No git/test/PR logic here.
import { nowIso } from './db.js';

export const STATES = ["draft", "queued", "active", "done", "cancelled", "failed"];
export const TERMINAL = ["done", "cancelled", "failed"];
export const TYPES = ["feature", "bug", "refactor", "chore"];

export class TaskError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Slug: lowercase, non-alnum runs become one dash, trimmed, max 40.
export function slugify(title) {
  const s = String(title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s === "" ? "task" : s;
}

// Ensure a workspace row exists for a canonical path; returns its id.
export function ensureWorkspace(db, path) {
  const now = nowIso();
  db.prepare("INSERT OR IGNORE INTO workspaces (path, base_branch, created_at, updated_at) VALUES (?, ?, ?, ?)").run(path, "", now, now);
  const row = db.prepare("SELECT id FROM workspaces WHERE path = ?").get(path);
  return row.id;
}

function branchFor(num, slug) { return "task/" + num + "-" + slug; }

// Resolve a caller-supplied number to the internal row: the global id first
// (every id that ever worked keeps working), then the per-workspace visible
// seq (what the panel and tools display as #N). Workspace-scoped: a number
// from another workspace never resolves here.
export function resolveTask(db, workspaceId, num) {
  const t = get(db, num);
  if (t && t.workspace_id === workspaceId) return t;
  return db.prepare("SELECT * FROM tasks WHERE workspace_id = ? AND seq = ?").get(workspaceId, num) ?? null;
}

function promoteIfFree(db, workspaceId) {
  const active = db.prepare("SELECT id FROM tasks WHERE workspace_id = ? AND state = ? LIMIT 1").get(workspaceId, "active");
  if (active) return null;
  const next = db.prepare("SELECT id, seq, slug FROM tasks WHERE workspace_id = ? AND state = ? ORDER BY id ASC LIMIT 1").get(workspaceId, "queued");
  if (!next) return null;
  const now = nowIso();
  let branch = branchFor(next.seq, next.slug);
  // Clash against every non-draft row: a closed task's branch may still exist
  // in git (branches are never deleted on close — design S8), so reusing it
  // would collide. Drafts carry no branch yet and are excluded.
  const clash = db.prepare("SELECT id FROM tasks WHERE workspace_id = ? AND branch = ? AND state != ? LIMIT 1");
  let n = 2;
  while (clash.get(workspaceId, branch, "draft")) { branch = branchFor(next.seq, next.slug) + "-" + n; n += 1; }
  db.prepare("UPDATE tasks SET state = ?, branch = ?, updated_at = ? WHERE id = ?").run("active", branch, now, next.id);
  return { id: next.id, seq: next.seq, branch };
}

export function enqueue(db, workspaceId, input) {
  if (!TYPES.includes(input.type)) throw new TaskError("bad-type", "type must be one of " + TYPES.join("|"));
  if (typeof input.title !== "string" || input.title.trim() === "") throw new TaskError("bad-title", "title must be a non-empty string");
  const slug = slugify(input.title);
  const now = nowIso();
  const spec = typeof input.spec === "string" ? input.spec : "";
  // seq is allocated atomically with the row: a single INSERT computes
  // MAX(seq)+1 inside the workspace, so two racing enqueues serialize on the
  // SQLite write lock and can never share a number (UNIQUE(workspace_id, seq)
  // is the backstop).
  const res = db.prepare("INSERT INTO tasks (workspace_id, seq, type, title, slug, spec, branch, state, created_at, updated_at) VALUES (?, COALESCE((SELECT MAX(seq) FROM tasks WHERE workspace_id = ?), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?)").run(workspaceId, workspaceId, input.type, input.title, slug, spec, "", "draft", now, now);
  return get(db, Number(res.lastInsertRowid));
}

// Draft-only revision for the triage/intake model: amends title/spec/type of
// an existing draft instead of filing a duplicate. Drafts carry no branch
// yet (branch is assigned at promotion), so a title change only recomputes
// the slug; queued/active/closed rows are rejected, never mutated.
export function editDraft(db, id, input) {
  const t = get(db, id);
  if (!t) throw new TaskError("not-found", "no task #" + id);
  if (t.state !== "draft") throw new TaskError("bad-state", "only drafts can be edited (task #" + t.seq + " is " + t.state + ")");
  const type = input.type !== undefined ? input.type : t.type;
  if (!TYPES.includes(type)) throw new TaskError("bad-type", "type must be one of " + TYPES.join("|"));
  const title = input.title !== undefined ? input.title : t.title;
  if (typeof title !== "string" || title.trim() === "") throw new TaskError("bad-title", "title must be a non-empty string");
  const slug = slugify(title);
  const spec = input.spec !== undefined ? input.spec : t.spec;
  db.prepare("UPDATE tasks SET type = ?, title = ?, slug = ?, spec = ?, updated_at = ? WHERE id = ?").run(type, title, slug, spec, nowIso(), id);
  return get(db, id);
}

export function approve(db, id) {
  const t = get(db, id);
  if (!t) throw new TaskError("not-found", "no task #" + id);
  if (t.state !== "draft") throw new TaskError("bad-state", "only draft can be approved (task #" + t.seq + " is " + t.state + ")");
  db.prepare("UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?").run("queued", nowIso(), id);
  const promoted = promoteIfFree(db, t.workspace_id);
  return { task: get(db, id), promoted };
}

export function close(db, id, outcome) {
  if (!TERMINAL.includes(outcome)) throw new TaskError("bad-outcome", "outcome must be one of " + TERMINAL.join("|"));
  const t = get(db, id);
  if (!t) throw new TaskError("not-found", "no task #" + id);
  if (TERMINAL.includes(t.state)) throw new TaskError("bad-state", "task #" + t.seq + " is already " + t.state);
  if (t.state === "draft" && outcome !== "cancelled") throw new TaskError("bad-state", "task #" + t.seq + " is still draft: only cancelled (discard) is allowed");
  const now = nowIso();
  db.prepare("UPDATE tasks SET state = ?, close_reason = ?, closed_at = ?, updated_at = ? WHERE id = ?").run(outcome, outcome, now, now, id);
  const promoted = promoteIfFree(db, t.workspace_id);
  return { task: get(db, id), promoted };
}

// Lazy worker bind: the system opens one chat per active task; the worker's
// first get_my_task read binds that session to the task (CAS: only when still
// unbound, so two racing readers cannot both win). No claim tool, no binding
// at approve time (the approver is the user, not the worker).
export function claimUnboundActive(db, id, sessionId) {
  const res = db.prepare("UPDATE tasks SET worker_session = ?, updated_at = ? WHERE id = ? AND state = ? AND worker_session IS NULL").run(sessionId, nowIso(), id, "active");
  if (res.changes === 0) {
    const t = get(db, id);
    if (!t) throw new TaskError("not-found", "no task #" + id);
    if (t.state !== "active") throw new TaskError("bad-state", "task #" + t.seq + " is " + t.state + ", not active");
    if (t.worker_session && t.worker_session !== sessionId) throw new TaskError("already-bound", "task #" + t.seq + " is already bound to another session");
  }
  return get(db, id);
}

export function bindSession(db, id, sessionId) {
  const t = get(db, id);
  if (!t) throw new TaskError("not-found", "no task #" + id);
  db.prepare("UPDATE tasks SET worker_session = ?, updated_at = ? WHERE id = ?").run(sessionId, nowIso(), id);
  return get(db, id);
}

export function get(db, id) {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) ?? null;
}

export function list(db, workspaceId, state) {
  if (state) return db.prepare("SELECT * FROM tasks WHERE workspace_id = ? AND state = ? ORDER BY id ASC").all(workspaceId, state);
  return db.prepare("SELECT * FROM tasks WHERE workspace_id = ? ORDER BY id ASC").all(workspaceId);
}

// Substring history search over title+spec (case-insensitive LIKE).
// Workspace-scoped like every other read; optional state filter; newest
// last (id ASC) with a cap. LIKE is enough for tens/hundreds of rows —
/// no FTS index needed at this scale.
export function search(db, workspaceId, query, state, limit) {
  const q = String(query ?? "").trim();
  if (q === "") throw new TaskError("bad-query", "query must be a non-empty string");
  if (state !== undefined && !STATES.includes(state)) throw new TaskError("bad-state", "state must be one of " + STATES.join("|"));
  const cap = limit === undefined ? 20 : limit;
  if (!Number.isInteger(cap) || cap < 1 || cap > 100) throw new TaskError("bad-limit", "limit must be an integer 1..100");
  const like = "%" + q.replace(/[%_\\]/g, (c) => "\\" + c) + "%";
  if (state) {
    return db.prepare(
      "SELECT * FROM tasks WHERE workspace_id = ? AND state = ? AND (title LIKE ? ESCAPE '\\' OR spec LIKE ? ESCAPE '\\') ORDER BY id ASC LIMIT ?"
    ).all(workspaceId, state, like, like, cap);
  }
  return db.prepare(
    "SELECT * FROM tasks WHERE workspace_id = ? AND (title LIKE ? ESCAPE '\\' OR spec LIKE ? ESCAPE '\\') ORDER BY id ASC LIMIT ?"
  ).all(workspaceId, like, like, cap);
}
