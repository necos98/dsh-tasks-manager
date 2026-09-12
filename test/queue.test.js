import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openMemory } from '../lib/db.js';
import { approve, bindSession, close, editDraft, enqueue, ensureWorkspace, get, list, queueEnabled, resolveTask, search, setQueueEnabled, slugify, startTask } from '../lib/queue.js';

function fresh() { const h = openMemory(); const ws = ensureWorkspace(h.db, 'C:/repo'); return { h, ws }; }

describe('slugify', () => {
  it('derives branch-safe slugs', () => { assert.equal(slugify('Login scazza su mobile!'), 'login-scazza-su-mobile'); assert.equal(slugify('!!!'), 'task'); });
});

describe('queue', () => {
  it('enqueue creates drafts without occupying the slot', () => {
    const { h, ws } = fresh();
    const a = enqueue(h.db, ws, { type: 'bug', title: 'Login mobile', spec: 'x' });
    assert.equal(a.state, 'draft'); assert.equal(a.branch, '');
    h.close();
  });

  it('approve always goes queued, first one promotes to active', () => {
    const { h, ws } = fresh();
    const a = enqueue(h.db, ws, { type: 'bug', title: 'Login mobile' });
    const r = approve(h.db, a.id);
    assert.equal(r.task.state, 'active'); assert.equal(r.task.branch, 'task/' + a.seq + '-login-mobile');
    assert.equal(r.promoted.id, a.id);
    h.close();
  });

  it('second approve stays queued until close frees the slot (FIFO)', () => {
    const { h, ws } = fresh();
    const a = enqueue(h.db, ws, { type: 'bug', title: 'First' });
    const b = enqueue(h.db, ws, { type: 'feature', title: 'Second' });
    approve(h.db, a.id);
    const rb = approve(h.db, b.id);
    assert.equal(rb.task.state, 'queued'); assert.equal(rb.promoted, null);
    const rc = close(h.db, a.id, 'done');
    assert.equal(rc.task.state, 'done');
    assert.equal(rc.promoted.id, b.id);
    assert.equal(get(h.db, b.id).state, 'active');
    h.close();
  });

  it('FIFO follows approval order, not insertion order', () => {
    const { h, ws } = fresh();
    // A blocker occupies the slot so all three approvals stay queued.
    const blocker = enqueue(h.db, ws, { type: 'bug', title: 'Blocker' });
    approve(h.db, blocker.id);
    const one = enqueue(h.db, ws, { type: 'bug', title: 'One' });
    const two = enqueue(h.db, ws, { type: 'bug', title: 'Two' });
    const three = enqueue(h.db, ws, { type: 'bug', title: 'Three' });
    // Approve in reverse insertion order: #3, then #1, then #2.
    approve(h.db, three.id);
    approve(h.db, one.id);
    approve(h.db, two.id);
    assert.deepEqual(list(h.db, ws, 'queued').map((t) => t.id), [three.id, one.id, two.id]);
    // Freeing the slot promotes the first-APPROVED task, not the lowest id.
    const rc = close(h.db, blocker.id, 'done');
    assert.equal(rc.promoted.id, three.id);
    assert.equal(get(h.db, three.id).state, 'active');
    assert.deepEqual(list(h.db, ws, 'queued').map((t) => t.id), [one.id, two.id]);
    h.close();
  });

  it('approve records queued_at on the row', () => {
    const { h, ws } = fresh();
    const a = enqueue(h.db, ws, { type: 'bug', title: 'Stamped' });
    assert.equal(get(h.db, a.id).queued_at, null);
    approve(h.db, a.id);
    assert.ok(typeof get(h.db, a.id).queued_at === 'string', 'queued_at is stamped at approval');
    h.close();
  });

  it('rejects bad transitions and bad enums', () => {
    const codeOf = (fn) => { try { fn(); } catch (e) { return e.code; } return 'no-throw'; };
    const { h, ws } = fresh();
    assert.equal(codeOf(() => enqueue(h.db, ws, { type: 'nope', title: 'X' })), 'bad-type');
    const a = enqueue(h.db, ws, { type: 'bug', title: 'X' });
    assert.equal(codeOf(() => approve(h.db, 9999)), 'not-found');
    assert.equal(codeOf(() => close(h.db, a.id, 'done')), 'bad-state');
    approve(h.db, a.id);
    const b = enqueue(h.db, ws, { type: 'chore', title: 'Scrap' });
    const disc = close(h.db, b.id, 'cancelled'); assert.equal(disc.task.state, 'cancelled');
    assert.equal(codeOf(() => approve(h.db, a.id)), 'bad-state');
    assert.equal(codeOf(() => close(h.db, a.id, 'shipped')), 'bad-outcome');
    h.close();
  });

  it('editDraft revises a draft: title recomputes slug, spec/type preserved or updated', () => {
    const { h, ws } = fresh();
    const a = enqueue(h.db, ws, { type: 'bug', title: 'Login mobile', spec: 'old spec' });
    const before = get(h.db, a.id).updated_at;
    const renamed = editDraft(h.db, a.id, { title: 'Login desktop' });
    assert.equal(renamed.title, 'Login desktop');
    assert.equal(renamed.slug, 'login-desktop');
    assert.equal(renamed.type, 'bug');
    assert.equal(renamed.spec, 'old spec');
    const respec = editDraft(h.db, a.id, { spec: 'new spec' });
    assert.equal(respec.spec, 'new spec');
    assert.equal(respec.title, 'Login desktop');
    const cleared = editDraft(h.db, a.id, { spec: '' });
    assert.equal(cleared.spec, '');
    const retyped = editDraft(h.db, a.id, { type: 'feature' });
    assert.equal(retyped.type, 'feature');
    assert.equal(retyped.title, 'Login desktop');
    assert.ok(retyped.updated_at >= before, 'updated_at moves forward');
    h.close();
  });

  it('editDraft rejects non-drafts, unknown ids, and bad type/title', () => {
    const codeOf = (fn) => { try { fn(); } catch (e) { return e.code; } return 'no-throw'; };
    const { h, ws } = fresh();
    const a = enqueue(h.db, ws, { type: 'bug', title: 'Mine' });
    assert.equal(codeOf(() => editDraft(h.db, 9999, { title: 'X' })), 'not-found');
    assert.equal(codeOf(() => editDraft(h.db, a.id, { type: 'nope' })), 'bad-type');
    assert.equal(codeOf(() => editDraft(h.db, a.id, { title: '' })), 'bad-title');
    assert.equal(codeOf(() => editDraft(h.db, a.id, { title: '   ' })), 'bad-title');
    assert.equal(get(h.db, a.id).title, 'Mine');
    approve(h.db, a.id); // active now
    assert.equal(codeOf(() => editDraft(h.db, a.id, { title: 'Late' })), 'bad-state');
    close(h.db, a.id, 'done');
    assert.equal(codeOf(() => editDraft(h.db, a.id, { title: 'Later' })), 'bad-state');
    const b = enqueue(h.db, ws, { type: 'chore', title: 'Second' });
    approve(h.db, b.id); // queued behind nothing? active or queued — both non-draft
    assert.equal(codeOf(() => editDraft(h.db, b.id, { spec: 'x' })), 'bad-state');
    const c = enqueue(h.db, ws, { type: 'chore', title: 'Third' });
    const disc = close(h.db, c.id, 'cancelled');
    assert.equal(disc.task.state, 'cancelled');
    assert.equal(codeOf(() => editDraft(h.db, c.id, { spec: 'x' })), 'bad-state');
    h.close();
  });

  it('one active per workspace, independent across workspaces', () => {
    const { h } = fresh(); const ws2 = ensureWorkspace(h.db, "C:/other");
    const a = enqueue(h.db, 1, { type: 'bug', title: 'A' });
    const b = enqueue(h.db, ws2, { type: 'bug', title: 'B' });
    approve(h.db, a.id); approve(h.db, b.id);
    assert.equal(get(h.db, a.id).state, 'active'); assert.equal(get(h.db, b.id).state, 'active');
    h.close();
  });

  it('bindSession + list filter', () => {
    const { h, ws } = fresh();
    const a = enqueue(h.db, ws, { type: 'bug', title: 'A' });
    approve(h.db, a.id);
    bindSession(h.db, a.id, 'sess-1');
    assert.equal(get(h.db, a.id).worker_session, 'sess-1');
    assert.equal(list(h.db, ws, 'active').length, 1);
    assert.equal(list(h.db, ws, 'queued').length, 0);
    h.close();
  });

  it('search finds title+spec matches, scoped per workspace', () => {
    const { h, ws } = fresh();
    const ws2 = ensureWorkspace(h.db, 'C:/other');
    enqueue(h.db, ws, { type: 'bug', title: 'Login crash on mobile', spec: 'problem: crash on tap' });
    enqueue(h.db, ws, { type: 'feature', title: 'Dark mode', spec: 'problem: bright screen' });
    enqueue(h.db, ws2, { type: 'bug', title: 'Login crash on mobile', spec: 'same words, other workspace' });
    const hits = search(h.db, ws, 'login');
    assert.equal(hits.length, 1);
    assert.match(hits[0].title, /Login crash/);
    // Case-insensitive + spec match.
    assert.equal(search(h.db, ws, 'BRIGHT').length, 1);
    assert.equal(search(h.db, ws, 'zzz-no-match').length, 0);
    h.close();
  });

  it('search honors state filter, limit, and rejects bad input', () => {
    const codeOf = (fn) => { try { fn(); } catch (e) { return e.code; } return 'no-throw'; };
    const { h, ws } = fresh();
    const a = enqueue(h.db, ws, { type: 'bug', title: 'Flaky test', spec: '' });
    enqueue(h.db, ws, { type: 'bug', title: 'Flaky test', spec: '' });
    approve(h.db, a.id);
    assert.equal(search(h.db, ws, 'flaky', 'active').length, 1);
    assert.equal(search(h.db, ws, 'flaky', 'draft').length, 1);
    assert.equal(search(h.db, ws, 'flaky', undefined, 1).length, 1);
    assert.equal(codeOf(() => search(h.db, ws, '')), 'bad-query');
    assert.equal(codeOf(() => search(h.db, ws, 'x', 'nope')), 'bad-state');
    assert.equal(codeOf(() => search(h.db, ws, 'x', undefined, 0)), 'bad-limit');
    h.close();
  });
});

// The per-project switch (workspaces.queue_enabled): ON is today's automatic
// FIFO, OFF freezes advancement and hands promotion to startTask alone.
describe('per-project queue pause', () => {
  const codeOf = (fn) => { try { fn(); } catch (e) { return e.code; } return 'no-throw'; };

  it('fresh databases are v5 with the queue enabled', () => {
    const { h, ws } = fresh();
    assert.equal(h.db.prepare("PRAGMA user_version").get().user_version, 5);
    assert.equal(h.db.prepare("SELECT queue_enabled AS q FROM workspaces WHERE id = ?").get(ws).q, 1);
    h.close();
  });

  it('queueEnabled defaults to true and follows the stored flag', () => {
    const { h, ws } = fresh();
    assert.equal(queueEnabled(h.db, ws), true);
    setQueueEnabled(h.db, ws, false);
    assert.equal(queueEnabled(h.db, ws), false);
    setQueueEnabled(h.db, ws, true);
    assert.equal(queueEnabled(h.db, ws), true);
    // Fail-open on an unknown workspace: no row reads as enabled.
    assert.equal(queueEnabled(h.db, 4242), true);
    h.close();
  });

  it('paused: approve queues without promoting, close leaves the head asleep', () => {
    const { h, ws } = fresh();
    setQueueEnabled(h.db, ws, false);
    const a = enqueue(h.db, ws, { type: 'bug', title: 'First' });
    const ra = approve(h.db, a.id);
    assert.equal(ra.task.state, 'queued');
    assert.equal(ra.task.branch, '');
    assert.equal(ra.promoted, null);
    const b = enqueue(h.db, ws, { type: 'feature', title: 'Second' });
    assert.equal(approve(h.db, b.id).promoted, null);
    assert.deepEqual(list(h.db, ws, 'queued').map((t) => t.id), [a.id, b.id]);
    assert.equal(list(h.db, ws, 'active').length, 0);
    // Nothing is active, so a close has no slot to free: no promotion either.
    const rc = close(h.db, a.id, 'cancelled');
    assert.equal(rc.promoted, null);
    assert.equal(get(h.db, b.id).state, 'queued');
    h.close();
  });

  it('startTask promotes exactly the chosen queued row, with the clash suffix', () => {
    const { h, ws } = fresh();
    setQueueEnabled(h.db, ws, false);
    const one = enqueue(h.db, ws, { type: 'bug', title: 'One' });
    const two = enqueue(h.db, ws, { type: 'bug', title: 'Two' });
    approve(h.db, one.id);
    approve(h.db, two.id);
    // Legacy collision: a closed row still holds the branch this promotion
    // would compute (branches are never deleted on close — design S8), so the
    // suffix must bump instead of reusing it.
    const legacy = enqueue(h.db, ws, { type: 'bug', title: 'Legacy' });
    close(h.db, legacy.id, 'cancelled');
    h.db.prepare("UPDATE tasks SET branch = ? WHERE id = ?").run('task/' + two.seq + '-two', legacy.id);
    // Manual choice beats FIFO order: the SECOND queued row goes active.
    const r = startTask(h.db, ws, two.id);
    assert.equal(r.task.state, 'active');
    assert.equal(r.task.branch, 'task/' + two.seq + '-two-2');
    assert.equal(r.promoted.id, two.id);
    assert.equal(get(h.db, one.id).state, 'queued');
    h.close();
  });

  it('startTask rejects non-queued ids and a busy slot without mutating', () => {
    const { h, ws } = fresh();
    const draft = enqueue(h.db, ws, { type: 'bug', title: 'Draft' });
    assert.equal(codeOf(() => startTask(h.db, ws, draft.id)), 'bad-state');
    assert.equal(codeOf(() => startTask(h.db, ws, 9999)), 'not-found');
    setQueueEnabled(h.db, ws, false);
    const one = enqueue(h.db, ws, { type: 'bug', title: 'One' });
    const two = enqueue(h.db, ws, { type: 'bug', title: 'Two' });
    approve(h.db, one.id);
    approve(h.db, two.id);
    startTask(h.db, ws, one.id); // slot now occupied
    const before = get(h.db, two.id);
    assert.equal(codeOf(() => startTask(h.db, ws, two.id)), 'slot-busy');
    assert.deepEqual(get(h.db, two.id), before);
    h.close();
  });

  it('setQueueEnabled(true) promotes the FIFO head when the slot is free', () => {
    const { h, ws } = fresh();
    setQueueEnabled(h.db, ws, false);
    const first = enqueue(h.db, ws, { type: 'bug', title: 'First' });
    const second = enqueue(h.db, ws, { type: 'bug', title: 'Second' });
    approve(h.db, first.id);
    approve(h.db, second.id);
    const out = setQueueEnabled(h.db, ws, true);
    assert.equal(out.queueEnabled, true);
    // first was approved first, so it is the FIFO head that resumes.
    assert.equal(out.promoted.id, first.id);
    assert.equal(get(h.db, first.id).state, 'active');
    assert.equal(get(h.db, second.id).state, 'queued');
    // Resuming with the slot busy promotes nothing.
    assert.equal(setQueueEnabled(h.db, ws, true).promoted, null);
    h.close();
  });

  it('the pause is per project: repo-a paused, repo-b keeps promoting', () => {
    const { h, ws } = fresh();
    const ws2 = ensureWorkspace(h.db, 'C:/other');
    setQueueEnabled(h.db, ws, false);
    const a = enqueue(h.db, ws, { type: 'bug', title: 'Paused one' });
    const b = enqueue(h.db, ws2, { type: 'bug', title: 'Live one' });
    assert.equal(approve(h.db, a.id).task.state, 'queued');
    assert.equal(approve(h.db, b.id).task.state, 'active');
    assert.equal(queueEnabled(h.db, ws), false);
    assert.equal(queueEnabled(h.db, ws2), true);
    h.close();
  });
});

describe('per-workspace numbering', () => {
  it('fresh workspaces both start at #1; second task in a workspace is #2', () => {
    const { h, ws } = fresh();
    const ws2 = ensureWorkspace(h.db, 'C:/other');
    const xa = enqueue(h.db, ws, { type: 'bug', title: 'First X' });
    const yb = enqueue(h.db, ws2, { type: 'bug', title: 'First Y' });
    const xc = enqueue(h.db, ws, { type: 'bug', title: 'Second X' });
    // Global ids keep leaking across workspaces (internal identity)...
    assert.deepEqual([xa.id, yb.id, xc.id], [1, 2, 3]);
    // ...but the visible numbers restart per workspace.
    assert.deepEqual([xa.seq, yb.seq, xc.seq], [1, 1, 2]);
    h.close();
  });

  it('new branches use the visible number, so equal slugs diverge per workspace', () => {
    const { h, ws } = fresh();
    const ws2 = ensureWorkspace(h.db, 'C:/other');
    const a = enqueue(h.db, ws, { type: 'bug', title: 'Same name' });
    const b = enqueue(h.db, ws2, { type: 'bug', title: 'Same name' });
    const ra = approve(h.db, a.id);
    const rb = approve(h.db, b.id);
    assert.equal(ra.task.branch, 'task/1-same-name');
    assert.equal(rb.task.branch, 'task/1-same-name');
    h.close();
  });

  it('resolveTask accepts the global id and the visible seq, scoped per workspace', () => {
    const { h, ws } = fresh();
    const ws2 = ensureWorkspace(h.db, 'C:/other');
    enqueue(h.db, ws2, { type: 'bug', title: 'Other first' }); // global id 1, seq 1 in ws2
    const mine = enqueue(h.db, ws, { type: 'bug', title: 'Mine' }); // global id 2, seq 1 in ws
    // By global id (back-compat) and by visible seq (what the panel shows).
    assert.equal(resolveTask(h.db, ws, mine.id).title, 'Mine');
    assert.equal(resolveTask(h.db, ws, 1).title, 'Mine');
    // Cross-workspace numbers never resolve: id 1 belongs to ws2, and ws has no seq 99.
    assert.equal(resolveTask(h.db, ws, 99), null);
    assert.equal(resolveTask(h.db, ws2, mine.id), null);
    h.close();
  });

  it('ambiguous numbers prefer the global id (back-compat precedence)', () => {
    const { h, ws } = fresh();
    const ws2 = ensureWorkspace(h.db, 'C:/other');
    enqueue(h.db, ws2, { type: 'bug', title: 'Other' }); // global id 1
    const first = enqueue(h.db, ws, { type: 'bug', title: 'First' }); // global id 2, seq 1
    const second = enqueue(h.db, ws, { type: 'bug', title: 'Second' }); // global id 3, seq 2
    // 2 is both first's global id and second's visible seq: the id wins, so
    // every number that ever worked keeps resolving to the same row.
    assert.equal(resolveTask(h.db, ws, 2).id, first.id);
    assert.equal(resolveTask(h.db, ws, 3).id, second.id);
    h.close();
  });

  it('v2 databases migrate to v5 with deterministic seq backfill, ids untouched', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { DatabaseSync } = await import('node:sqlite');
    const { openDatabase } = await import('../lib/db.js');
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tasks-v2-'));
    const path = join(dir, 'tasks.db');
    try {
      // Faithful v2 layout: SCHEMA_VERSION-2 DDL, no seq column.
      const raw = new DatabaseSync(path);
      raw.exec("PRAGMA application_id = 2003397999");
      raw.exec("CREATE TABLE workspaces (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, base_branch TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      raw.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, type TEXT NOT NULL, title TEXT NOT NULL, slug TEXT NOT NULL, spec TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft', worker_session TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT, close_reason TEXT)");
      raw.exec("CREATE INDEX idx_tasks_ws_state ON tasks(workspace_id, state)");
      raw.exec("INSERT INTO workspaces (id, path, base_branch, created_at, updated_at) VALUES (1, 'C:/a', '', 't', 't'), (2, 'C:/b', '', 't', 't')");
      // Interleaved global ids across workspaces (the leak, frozen in history).
      raw.exec("INSERT INTO tasks (id, workspace_id, type, title, slug, spec, branch, state, created_at, updated_at) VALUES (1, 1, 'bug', 'A one', 'a-one', '', '', 'done', 't', 't'), (2, 2, 'bug', 'B one', 'b-one', '', '', 'done', 't', 't'), (3, 1, 'bug', 'A two', 'a-two', '', '', 'draft', 't', 't')");
      raw.exec("PRAGMA user_version = 2");
      raw.close();
      // Reopen through the plugin: the v2->v3->v4->v5 migration runs in place.
      const h = openDatabase({ path });
      try {
        assert.equal(h.db.prepare("PRAGMA user_version").get().user_version, 5);
        const rows = h.db.prepare("SELECT id, workspace_id, seq FROM tasks ORDER BY id ASC").all();
        assert.deepEqual(rows.map((r) => [r.id, r.workspace_id, r.seq]), [[1, 1, 1], [2, 2, 1], [3, 1, 2]]);
        const idx = h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_tasks_ws_seq'").get();
        assert.ok(idx, 'UNIQUE(workspace_id, seq) index exists');
        // v5 backfills the queue switch ON for every existing workspace.
        assert.deepEqual(h.db.prepare("SELECT queue_enabled FROM workspaces ORDER BY id ASC").all().map((w) => w.queue_enabled), [1, 1]);
        // New enqueues continue the per-workspace sequence, not the global id.
        const next = enqueue(h.db, 1, { type: 'bug', title: 'A three' });
        assert.equal(next.seq, 3);
      } finally {
        h.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('v1 databases migrate to v5 (column rename + seq backfill + queued_at)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { DatabaseSync } = await import('node:sqlite');
    const { openDatabase } = await import('../lib/db.js');
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tasks-v1-'));
    const path = join(dir, 'tasks.db');
    try {
      // Faithful v1 layout: Italian column names, pre-rename.
      const raw = new DatabaseSync(path);
      raw.exec("PRAGMA application_id = 2003397999");
      raw.exec("CREATE TABLE workspaces (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, base_branch TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      raw.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, tipo TEXT NOT NULL, titolo TEXT NOT NULL, slug TEXT NOT NULL, spec TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL, stato TEXT NOT NULL DEFAULT 'draft', worker_session TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT, close_reason TEXT)");
      raw.exec("CREATE INDEX idx_tasks_ws_stato ON tasks(workspace_id, stato)");
      raw.exec("INSERT INTO workspaces (id, path, base_branch, created_at, updated_at) VALUES (1, 'C:/a', '', 't', 't')");
      raw.exec("INSERT INTO tasks (id, workspace_id, tipo, titolo, slug, spec, branch, stato, created_at, updated_at) VALUES (1, 1, 'bug', 'Vecchio', 'vecchio', '', '', 'draft', 't', 't')");
      raw.exec("PRAGMA user_version = 1");
      raw.close();
      const h = openDatabase({ path });
      try {
        assert.equal(h.db.prepare("PRAGMA user_version").get().user_version, 5);
        const row = get(h.db, 1);
        assert.equal(row.type, 'bug');
        assert.equal(row.title, 'Vecchio');
        assert.equal(row.state, 'draft');
        assert.equal(row.seq, 1);
        assert.equal(row.queued_at, null);
        assert.equal(h.db.prepare("SELECT queue_enabled AS q FROM workspaces WHERE id = 1").get().q, 1);
      } finally {
        h.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('v3 databases migrate to v5 in place (queued_at added, rows NULL)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { DatabaseSync } = await import('node:sqlite');
    const { openDatabase } = await import('../lib/db.js');
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tasks-v3-'));
    const path = join(dir, 'tasks.db');
    try {
      // Faithful v3 layout: SCHEMA_VERSION-3 DDL, no queued_at column.
      const raw = new DatabaseSync(path);
      raw.exec("PRAGMA application_id = 2003397999");
      raw.exec("CREATE TABLE workspaces (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, base_branch TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      raw.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, seq INTEGER NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, slug TEXT NOT NULL, spec TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft', worker_session TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT, close_reason TEXT)");
      raw.exec("CREATE INDEX idx_tasks_ws_state ON tasks(workspace_id, state)");
      raw.exec("CREATE UNIQUE INDEX idx_tasks_ws_seq ON tasks(workspace_id, seq)");
      raw.exec("INSERT INTO workspaces (id, path, base_branch, created_at, updated_at) VALUES (1, 'C:/a', '', 't', 't')");
      raw.exec("INSERT INTO tasks (id, workspace_id, seq, type, title, slug, spec, branch, state, created_at, updated_at) VALUES (1, 1, 1, 'bug', 'Queued old', 'queued-old', '', '', 'queued', 't', 't')");
      raw.exec("PRAGMA user_version = 3");
      raw.close();
      // Reopen through the plugin: the v3->v4->v5 migration runs in place.
      const h = openDatabase({ path });
      try {
        assert.equal(h.db.prepare("PRAGMA user_version").get().user_version, 5);
        const cols = h.db.prepare("PRAGMA table_info(tasks)").all();
        assert.ok(cols.some((c) => c.name === 'queued_at'), 'queued_at column exists');
        const row = get(h.db, 1);
        assert.equal(row.state, 'queued');
        assert.equal(row.queued_at, null);
        assert.equal(h.db.prepare("SELECT queue_enabled AS q FROM workspaces WHERE id = 1").get().q, 1);
      } finally {
        h.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('v4 databases migrate to v5 in place (queue_enabled backfilled to 1)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { DatabaseSync } = await import('node:sqlite');
    const { openDatabase } = await import('../lib/db.js');
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tasks-v4-'));
    const path = join(dir, 'tasks.db');
    try {
      // Faithful v4 layout: queued_at present, no queue_enabled column.
      const raw = new DatabaseSync(path);
      raw.exec("PRAGMA application_id = 2003397999");
      raw.exec("CREATE TABLE workspaces (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, base_branch TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      raw.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, seq INTEGER NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, slug TEXT NOT NULL, spec TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft', worker_session TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT, close_reason TEXT, queued_at TEXT)");
      raw.exec("CREATE INDEX idx_tasks_ws_state ON tasks(workspace_id, state)");
      raw.exec("CREATE UNIQUE INDEX idx_tasks_ws_seq ON tasks(workspace_id, seq)");
      raw.exec("INSERT INTO workspaces (id, path, base_branch, created_at, updated_at) VALUES (1, 'C:/a', '', 't', 't'), (2, 'C:/b', '', 't', 't')");
      raw.exec("INSERT INTO tasks (id, workspace_id, seq, type, title, slug, spec, branch, state, created_at, updated_at, queued_at) VALUES (1, 1, 1, 'bug', 'Waiting', 'waiting', '', '', 'queued', 't', 't', '2026-01-01T00:00:00.000Z')");
      raw.exec("PRAGMA user_version = 4");
      raw.close();
      // Reopen through the plugin: the v4->v5 migration runs in place.
      const h = openDatabase({ path });
      try {
        assert.equal(h.db.prepare("PRAGMA user_version").get().user_version, 5);
        const cols = h.db.prepare("PRAGMA table_info(workspaces)").all();
        assert.ok(cols.some((c) => c.name === 'queue_enabled'), 'queue_enabled column exists');
        // Every pre-existing workspace keeps the automatic behavior.
        assert.deepEqual(h.db.prepare("SELECT queue_enabled FROM workspaces ORDER BY id ASC").all().map((w) => w.queue_enabled), [1, 1]);
        assert.equal(queueEnabled(h.db, 1), true);
        // The old queued row and its stamp survive untouched.
        const row = get(h.db, 1);
        assert.equal(row.state, 'queued');
        assert.equal(row.queued_at, '2026-01-01T00:00:00.000Z');
      } finally {
        h.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
