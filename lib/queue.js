// dsh-tasks-manager — queue domain: the stupid deterministic core (pure).
// States: draft -> queued -> active -> done|cancelled|failed.
// Rules: approve always goes to queued; promotion is FIFO (approval order:
// queued_at ASC, id ASC tiebreaker) when no active AND the project queue is
// enabled (workspaces.queue_enabled, default on); a paused project promotes
// only through the explicit startTask(id);
// close is user-only and frees the slot, and requeue (active -> queued) is
// user-only too: it frees the slot the same way, at the END of the FIFO and
// keeping the branch. The queued order is DERIVED from
// queued_at (never stored as an index): moveQueued rewrites the stamps of the
// whole queued set and never promotes. appendNote grows the per-task notes
// log (append-only, worker-written) without touching a single queue field.
// No git/test/PR logic here.
import { nowIso } from './db.js';

export const STATES = ["draft", "queued", "active", "done", "cancelled", "failed"];
export const TERMINAL = ["done", "cancelled", "failed"];
export const TYPES = ["feature", "bug", "refactor", "chore"];
// Notes log caps: NOTE_MAX_CHARS bounds ONE entry (after trim), NOTES_MAX_CHARS
// bounds the whole log of a task. Plain numbers, enforced before the write.
export const NOTE_MAX_CHARS = 2000;
export const NOTES_MAX_CHARS = 20000;

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

// Per-project queue switch (workspaces.queue_enabled): true means the queue
// advances on its own (promotion after approve/close), false means it is
// paused and only an explicit startTask promotes. Fail-open: a missing
// workspace row, a pre-v5 database without the column, or any value other
// than the explicit 0 reads as enabled, so old databases keep today's
// behavior. Reads are workspace-scoped like every other access here.
export function queueEnabled(db, workspaceId) {
  let row;
  try {
    row = db.prepare("SELECT queue_enabled FROM workspaces WHERE id = ?").get(workspaceId);
  } catch {
    return true;
  }
  if (!row) return true;
  return row.queue_enabled !== 0;
}

// Resolve a caller-supplied number to the internal row: the visible
// per-workspace number wins (it is what the panel card, fmt() and list_tasks
// print as #N, so it must be the addressable number), and the internal global
// id is accepted only when no row of this workspace carries that seq (legacy
// callers, ids beyond this workspace's seq range). Workspace-scoped: a number
// from another workspace never resolves here.
export function resolveTask(db, workspaceId, num) {
  const bySeq = db.prepare("SELECT * FROM tasks WHERE workspace_id = ? AND seq = ?").get(workspaceId, num);
  if (bySeq) return bySeq;
  const t = get(db, num);
  return t && t.workspace_id === workspaceId ? t : null;
}

// Promotion core: assign the branch and flip ONE chosen row to active.
// Callers own the slot check (automatic FIFO promotion and the manual Start
// share this, so branch assignment and the clash rule live in one place).
function promoteRow(db, workspaceId, row) {
  const now = nowIso();
  let branch = branchFor(row.seq, row.slug);
  // Clash against every OTHER non-draft row: a closed task's branch may still
  // exist in git (branches are never deleted on close — design S8), so reusing
  // it would collide. Drafts carry no branch yet and are excluded; the row
  // being promoted is excluded too, so requeue() re-promotes it onto its own
  // branch instead of suffixing itself with -2.
  const clash = db.prepare("SELECT id FROM tasks WHERE workspace_id = ? AND branch = ? AND state != ? AND id != ? LIMIT 1");
  let n = 2;
  while (clash.get(workspaceId, branch, "draft", row.id)) { branch = branchFor(row.seq, row.slug) + "-" + n; n += 1; }
  db.prepare("UPDATE tasks SET state = ?, branch = ?, updated_at = ? WHERE id = ?").run("active", branch, now, row.id);
  return { id: row.id, seq: row.seq, branch };
}

// Automatic advancement: FIFO head (approval order) into the free slot.
// A paused workspace promotes nothing — that is the whole point of the
// switch — and manual startTask takes over from here.
function promoteIfFree(db, workspaceId) {
  if (!queueEnabled(db, workspaceId)) return null;
  const active = db.prepare("SELECT id FROM tasks WHERE workspace_id = ? AND state = ? LIMIT 1").get(workspaceId, "active");
  if (active) return null;
  const next = db.prepare("SELECT id, seq, slug FROM tasks WHERE workspace_id = ? AND state = ? ORDER BY queued_at ASC, id ASC LIMIT 1").get(workspaceId, "queued");
  if (!next) return null;
  return promoteRow(db, workspaceId, next);
}

// Pause/resume the project queue. Resuming promotes the FIFO head when the
// slot is free (same funnel as approve/close); pausing only writes the flag
// and leaves every row exactly where it is.
export function setQueueEnabled(db, workspaceId, enabled) {
  const on = enabled === true;
  db.prepare("UPDATE workspaces SET queue_enabled = ?, updated_at = ? WHERE id = ?").run(on ? 1 : 0, nowIso(), workspaceId);
  const promoted = on ? promoteIfFree(db, workspaceId) : null;
  return { queueEnabled: queueEnabled(db, workspaceId), promoted };
}

// Manual start: promote exactly the queued row the user picked, paused queue
// or not. Same shape as approve(); the slot rule still holds (one active per
// workspace), so a busy project rejects instead of queueing two workers.
export function startTask(db, workspaceId, id) {
  const t = get(db, id);
  if (!t || t.workspace_id !== workspaceId) throw new TaskError("not-found", "no task #" + id);
  if (t.state !== "queued") throw new TaskError("bad-state", "only queued tasks can be started (task #" + t.seq + " is " + t.state + ")");
  const active = db.prepare("SELECT id, seq FROM tasks WHERE workspace_id = ? AND state = ? LIMIT 1").get(workspaceId, "active");
  if (active) throw new TaskError("slot-busy", "task #" + active.seq + " is already active");
  const promoted = promoteRow(db, workspaceId, t);
  return { task: get(db, id), promoted };
}

// Reorder the queued set (panel ▲/▼): swap the picked task with its neighbour,
// then re-stamp queued_at for the WHOLE queue in the new order. The order is
// derived, never stored: promoteIfFree() and list() read the same
// "queued_at ASC, id ASC" clause, so rewriting the stamps IS the reorder.
// Never promotes (no promoteIfFree call): a free slot with queued rows exists
// only while the project queue is paused, and starting work stays an explicit
// user action. Edge calls (up on the head, down on the tail) are a no-op that
// mutates nothing.
export function moveQueued(db, workspaceId, id, direction) {
  if (direction !== "up" && direction !== "down") {
    throw new TaskError("bad-direction", 'direction must be "up" or "down"');
  }
  const t = get(db, id);
  if (!t || t.workspace_id !== workspaceId) throw new TaskError("not-found", "no task #" + id);
  if (t.state !== "queued") {
    throw new TaskError("bad-state", "only queued tasks can be reordered (task #" + t.seq + " is " + t.state + ")");
  }
  const rows = db.prepare("SELECT id FROM tasks WHERE workspace_id = ? AND state = ? ORDER BY queued_at ASC, id ASC").all(workspaceId, "queued");
  const index = rows.findIndex((row) => row.id === id);
  if (index === -1) throw new TaskError("not-found", "no task #" + id);
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= rows.length) {
    return { task: get(db, id), moved: false, queued: list(db, workspaceId, "queued") };
  }
  const order = rows.map((row) => row.id);
  order[index] = rows[target].id;
  order[target] = id;
  // Re-stamp strictly above the workspace maximum (1ms apart), so a later
  // approve() still lands AFTER the last queued row.
  const base = queuedBase(db, workspaceId);
  const now = nowIso();
  const stamp = db.prepare("UPDATE tasks SET queued_at = ?, updated_at = ? WHERE id = ?");
  order.forEach((rowId, k) => stamp.run(new Date(base + k + 1).toISOString(), now, rowId));
  return { task: get(db, id), moved: true, queued: list(db, workspaceId, "queued") };
}

// Stamp baseline for a reorder: the workspace's current MAX(queued_at), so the
// rewritten list sits above every stamp already handed out. A workspace whose
// queue is empty or unstamped falls back to "now".
function queuedBase(db, workspaceId) {
  const row = db.prepare("SELECT MAX(queued_at) AS m FROM tasks WHERE workspace_id = ?").get(workspaceId);
  const base = row && typeof row.m === "string" ? Date.parse(row.m) : NaN;
  return Number.isNaN(base) ? Date.parse(nowIso()) : base;
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

// Append ONE timestamped entry to a task's notes log (the worker's own
// record: findings, blockers, "flagged but not done" items). Append-only:
// earlier entries are never edited or reordered, so a note is a fact with a
// time, not a field to overwrite. Active tasks only — the log records work in
// progress, and a closed row is history. Touches ONLY notes + updated_at:
// state, queued_at, branch and worker_session are never written here, and no
// promotion runs (a note never moves the queue).
export function appendNote(db, id, text) {
  if (typeof text !== "string" || text.trim() === "") throw new TaskError("bad-note", "note text must be a non-empty string");
  const body = text.trim();
  if (body.length > NOTE_MAX_CHARS) throw new TaskError("note-too-long", "a note may be at most " + NOTE_MAX_CHARS + " characters");
  const t = get(db, id);
  if (!t) throw new TaskError("not-found", "no task #" + id);
  if (t.state !== "active") throw new TaskError("bad-state", "only active tasks can be annotated (task #" + t.seq + " is " + t.state + ")");
  const current = typeof t.notes === "string" ? t.notes : "";
  // One entry per line: "- [ISO] body". Internal newlines of the body are kept
  // verbatim, so a multi-paragraph note stays one appendable unit.
  const entry = "- [" + nowIso() + "] " + body;
  const next = current === "" ? entry : current + "\n" + entry;
  if (next.length > NOTES_MAX_CHARS) throw new TaskError("notes-full", "task #" + t.seq + " notes reached " + NOTES_MAX_CHARS + " characters");
  db.prepare("UPDATE tasks SET notes = ?, updated_at = ? WHERE id = ?").run(next, nowIso(), id);
  return get(db, id);
}

export function approve(db, id) {
  const t = get(db, id);
  if (!t) throw new TaskError("not-found", "no task #" + id);
  if (t.state !== "draft") throw new TaskError("bad-state", "only draft can be approved (task #" + t.seq + " is " + t.state + ")");
  db.prepare("UPDATE tasks SET state = ?, queued_at = ?, updated_at = ? WHERE id = ?").run("queued", nextQueuedAt(db, t.workspace_id), nowIso(), id);
  const promoted = promoteIfFree(db, t.workspace_id);
  return { task: get(db, id), promoted };
}

// Approval-order stamp: strictly increasing per workspace. nowIso() has
// millisecond precision, so rapid approvals would tie on queued_at and fall
// back to the id tiebreaker (insertion order) — defeating approval-order
// FIFO. Bump 1ms past the workspace max instead; ISO strings compare
// lexicographically in chronological order, same format throughout.
function nextQueuedAt(db, workspaceId) {
  const now = nowIso();
  const row = db.prepare("SELECT MAX(queued_at) AS m FROM tasks WHERE workspace_id = ?").get(workspaceId);
  if (row && typeof row.m === "string" && row.m >= now) {
    return new Date(Date.parse(row.m) + 1).toISOString();
  }
  return now;
}

// Inverse of approve(): pull a queued task back to draft so it becomes
// revisable again (editDraft) instead of only closable/discardable. A queued
// row never held the slot, so this frees nothing and must NOT promote: no
// promoteIfFree call, no spawn. The branch is assigned only at promotion, so
// the revert is a pure state reset — state, queued_at (back to NULL) and
// updated_at. seq, slug, spec, created_at and worker_session stay untouched,
// and a later approve() re-stamps queued_at, which lands the task at the END
// of the FIFO order, never back at its old position.
export function unqueue(db, id) {
  const t = get(db, id);
  if (!t) throw new TaskError("not-found", "no task #" + id);
  if (t.state !== "queued") {
    throw new TaskError("bad-state", "only queued tasks can go back to draft (task #" + t.seq + " is " + t.state + ")");
  }
  db.prepare("UPDATE tasks SET state = ?, queued_at = ?, updated_at = ? WHERE id = ?").run("draft", null, nowIso(), id);
  return { task: get(db, id), promoted: null };
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

// Return an active task to the queue so another task can take the slot, or so
// a dead worker chat can be replaced by a fresh one. Not a pure state reset
// like unqueue(): the row holds the slot and normally carries a branch and a
// bound worker session, so it frees the slot through the SAME funnel as close
// (promoteIfFree + spawn policy) and re-enters at the END of the FIFO. branch,
// seq, slug, spec and created_at stay untouched: the branch is resumed by the
// next promotion (promoteRow excludes the row itself from its clash query), so
// commits the previous worker already pushed stay valid; worker_session is
// cleared because the next promotion spawns a fresh worker chat.
export function requeue(db, id) {
  const t = get(db, id);
  if (!t) throw new TaskError("not-found", "no task #" + id);
  if (t.state !== "active") {
    throw new TaskError("bad-state", "only active tasks can go back to the queue (task #" + t.seq + " is " + t.state + ")");
  }
  db.prepare("UPDATE tasks SET state = ?, queued_at = ?, worker_session = ?, updated_at = ? WHERE id = ?").run("queued", nextQueuedAt(db, t.workspace_id), null, nowIso(), id);
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
  if (state === "queued") return db.prepare("SELECT * FROM tasks WHERE workspace_id = ? AND state = ? ORDER BY queued_at ASC, id ASC").all(workspaceId, state);
  if (state) return db.prepare("SELECT * FROM tasks WHERE workspace_id = ? AND state = ? ORDER BY id ASC").all(workspaceId, state);
  return db.prepare("SELECT * FROM tasks WHERE workspace_id = ? ORDER BY CASE WHEN state = 'queued' THEN queued_at END ASC, id ASC").all(workspaceId);
}

// Substring history search over title+spec+notes (case-insensitive LIKE).
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
  // IFNULL guards a legacy NULL row (v5 and older had no column at all, a
  // restored dump may still carry NULL): NULL LIKE x is NULL, i.e. no match.
  if (state) {
    return db.prepare(
      "SELECT * FROM tasks WHERE workspace_id = ? AND state = ? AND (title LIKE ? ESCAPE '\\' OR spec LIKE ? ESCAPE '\\' OR IFNULL(notes, '') LIKE ? ESCAPE '\\') ORDER BY id ASC LIMIT ?"
    ).all(workspaceId, state, like, like, like, cap);
  }
  return db.prepare(
    "SELECT * FROM tasks WHERE workspace_id = ? AND (title LIKE ? ESCAPE '\\' OR spec LIKE ? ESCAPE '\\' OR IFNULL(notes, '') LIKE ? ESCAPE '\\') ORDER BY id ASC LIMIT ?"
  ).all(workspaceId, like, like, like, cap);
}
