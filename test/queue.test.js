import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openMemory } from '../lib/db.js';
import { approve, bindSession, close, enqueue, ensureWorkspace, get, list, search, slugify } from '../lib/queue.js';

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
    assert.equal(r.task.state, 'active'); assert.equal(r.task.branch, 'task/' + a.id + '-login-mobile');
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
