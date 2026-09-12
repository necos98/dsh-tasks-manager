import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openMemory } from '../lib/db.js';
import { approve, enqueue, ensureWorkspace, get } from '../lib/queue.js';
import { createWebHandlers, routeWebCall } from '../lib/web.js';

// Mock store: in-memory DB + two-workspace registry. No DSH boot needed.
function mockStore() {
  const h = openMemory();
  const wsA = ensureWorkspace(h.db, 'C:/repo-a');
  const wsB = ensureWorkspace(h.db, 'C:/repo-b');
  const store = {
    getDb() { return h.db; },
    workspaceRegistry: {
      list() {
        return [
          { id: 'a', path: 'C:/repo-a', title: 'repo-a', sessionIds: ['sess-a'] },
          { id: 'b', path: 'C:/repo-b', title: 'repo-b', sessionIds: ['sess-b'] },
        ];
      },
    },
  };
  return { h, store, wsA, wsB };
}

describe('web RPC (panel channel)', () => {
  it('snapshot returns the caller workspace tasks', async () => {
    const { store } = mockStore();
    const handlers = createWebHandlers(store);
    enqueue(store.getDb(), 1, { type: 'bug', title: 'Login mobile', spec: 'x' });
    const out = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    assert.equal(out.ok, true);
    assert.equal(out.value.tasks.length, 1);
    assert.equal(out.value.tasks[0].title, 'Login mobile');
    assert.equal(out.value.workspace.id, 'a');
    // Manual defaults without a settings ctx.
    assert.equal(out.value.workerCanFinish, false);
    assert.equal(out.value.workerCanMerge, false);
    assert.equal(out.value.workerRules, '');
  });

  it('snapshot reports the live finish mode from settings', async () => {
    const { store } = mockStore();
    const handlers = createWebHandlers(store, {
      ctx: { get: (key) => key === 'settings' ? { get: () => ({ workerCanFinish: true }) } : undefined },
    });
    const out = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    assert.equal(out.ok, true);
    assert.equal(out.value.workerCanFinish, true);
    assert.equal(out.value.workerCanMerge, false);
  });

  it('snapshot reports the live merge mode from settings', async () => {
    const { store } = mockStore();
    const handlers = createWebHandlers(store, {
      ctx: { get: (key) => key === 'settings' ? { get: () => ({ workerCanMerge: true }) } : undefined },
    });
    const out = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    assert.equal(out.ok, true);
    assert.equal(out.value.workerCanMerge, true);
    assert.equal(out.value.workerCanFinish, false);
  });

  it('snapshot reports the live worker rules from settings', async () => {
    const { store } = mockStore();
    const handlers = createWebHandlers(store, {
      ctx: { get: (key) => key === 'settings' ? { get: () => ({ workerRules: 'alla fine del lavoro aggiorna la wiki' }) } : undefined },
    });
    const out = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    assert.equal(out.ok, true);
    assert.equal(out.value.workerRules, 'alla fine del lavoro aggiorna la wiki');
  });

  it('snapshot is workspace-scoped (sess-b sees nothing of repo-a)', async () => {
    const { store } = mockStore();
    const handlers = createWebHandlers(store);
    enqueue(store.getDb(), 1, { type: 'bug', title: 'Login mobile', spec: 'x' });
    const out = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-b' });
    assert.equal(out.ok, true);
    assert.deepEqual(out.value.tasks, []);
  });

  it('approve goes draft -> queued -> active via the channel', async () => {
    const { store } = mockStore();
    const handlers = createWebHandlers(store);
    const row = enqueue(store.getDb(), 1, { type: 'feature', title: 'Panel UI', spec: '' });
    const out = await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: row.id });
    assert.equal(out.ok, true);
    assert.equal(out.value.task.state, 'active');
    assert.ok(out.value.promoted);
  });

  it('snapshot rows carry the per-workspace seq; approve accepts it', async () => {
    const { h, store, wsA, wsB } = mockStore();
    const handlers = createWebHandlers(store);
    enqueue(h.db, wsB, { type: 'bug', title: 'Other first', spec: '' }); // global id 1
    const row = enqueue(h.db, wsA, { type: 'bug', title: 'Panel UI', spec: '' }); // global id 2, seq 1
    const snap = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    assert.equal(snap.ok, true);
    assert.equal(snap.value.tasks.length, 1);
    assert.equal(snap.value.tasks[0].seq, 1);
    // Approve by the visible #1 (not the global id 2).
    const out = await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: 1 });
    assert.equal(out.ok, true);
    assert.equal(out.value.task.id, row.id);
    assert.equal(out.value.task.state, 'active');
    h.close();
  });

  it('cross-workspace approve mutates nothing', async () => {
    const { store } = mockStore();
    const handlers = createWebHandlers(store);
    const row = enqueue(store.getDb(), 1, { type: 'bug', title: 'Other ws', spec: '' });
    const out = await routeWebCall(handlers, 'approve', { sessionId: 'sess-b', id: row.id });
    assert.equal(out.ok, false);
    assert.equal(out.value, undefined);
    assert.match(out.error.message, /no task/);
    // Untouched: still draft in repo-a.
    const again = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    assert.equal(again.value.tasks[0].state, 'draft');
  });

  it('close with outcome frees the slot', async () => {
    const { store } = mockStore();
    const handlers = createWebHandlers(store);
    const row = enqueue(store.getDb(), 1, { type: 'chore', title: 'Close me', spec: '' });
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: row.id });
    const out = await routeWebCall(handlers, 'close', { sessionId: 'sess-a', id: row.id, outcome: 'done' });
    assert.equal(out.ok, true);
    assert.equal(out.value.task.state, 'done');
  });

  it('snapshot lists queued rows in approval order', async () => {
    const { h, store, wsA } = mockStore();
    const handlers = createWebHandlers(store);
    const blocker = enqueue(h.db, wsA, { type: 'bug', title: 'Blocker', spec: '' });
    approve(h.db, blocker.id);
    const one = enqueue(h.db, wsA, { type: 'bug', title: 'One', spec: '' });
    const two = enqueue(h.db, wsA, { type: 'bug', title: 'Two', spec: '' });
    approve(h.db, two.id);
    approve(h.db, one.id);
    const out = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    assert.equal(out.ok, true);
    const queued = out.value.tasks.filter((t) => t.state === 'queued');
    assert.deepEqual(queued.map((t) => t.id), [two.id, one.id]);
    h.close();
  });

  it('unknown endpoint and bad payloads fail closed', async () => {
    const { store } = mockStore();
    const handlers = createWebHandlers(store);
    assert.equal((await routeWebCall(handlers, 'nope', {})).ok, false);
    assert.equal((await routeWebCall(handlers, 'snapshot', {})).ok, false);
    assert.equal((await routeWebCall(handlers, 'snapshot', { sessionId: 'ghost' })).ok, false);
    assert.equal((await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: 999 })).ok, false);
  });

  it('approve spawns the worker and binds its session', async () => {
    const { store } = mockStore();
    let spawned = null;
    const handlers = createWebHandlers(store, {
      ctx: { fake: true },
      spawnWorker: async ({ task }) => {
        spawned = task;
        const { bindSession } = await import('../lib/queue.js');
        bindSession(store.getDb(), task.id, 'sess-worker-1');
        return { sessionId: 'sess-worker-1' };
      },
    });
    const row = enqueue(store.getDb(), 1, { type: 'feature', title: 'Spawn me', spec: '' });
    const out = await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: row.id });
    assert.equal(out.ok, true);
    assert.equal(out.value.task.state, 'active');
    assert.ok(spawned, 'spawner was called');
    assert.equal(spawned.id, row.id);
    // The promoted row carries the bound worker session (no lazy race).
    assert.equal(out.value.promoted.worker_session, 'sess-worker-1');
    assert.deepEqual(out.value.spawn, { sessionId: 'sess-worker-1' });
  });

  it('a failed spawn keeps the task active with spawnError', async () => {
    const { store } = mockStore();
    const handlers = createWebHandlers(store, {
      ctx: { fake: true },
      spawnWorker: async () => { throw new Error('no agents today'); },
    });
    const row = enqueue(store.getDb(), 1, { type: 'bug', title: 'Keep me', spec: '' });
    const out = await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: row.id });
    assert.equal(out.ok, true);
    assert.equal(out.value.task.state, 'active');
    assert.match(out.value.spawn.error, /no agents today/);
  });

  it('close promotion spawns the next worker through the shared helper', async () => {
    const { store } = mockStore();
    // No hooks.spawnWorker: the real path (spawnForPromotion) runs and fails
    // closed without agents — the promotion still stands with the error.
    const handlers = createWebHandlers(store, { ctx: { get: () => undefined } });
    const one = enqueue(store.getDb(), 1, { type: 'bug', title: 'First', spec: '' });
    const two = enqueue(store.getDb(), 1, { type: 'bug', title: 'Second', spec: '' });
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: one.id });
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: two.id });
    const out = await routeWebCall(handlers, 'close', { sessionId: 'sess-a', id: one.id, outcome: 'done' });
    assert.equal(out.ok, true);
    assert.equal(out.value.task.state, 'done');
    assert.equal(out.value.promoted.id, two.id);
    assert.equal(out.value.promoted.state, 'active');
    assert.match(out.value.spawn.error, /agents service unavailable/);
  });
});

describe('web RPC queue switch (panel channel)', () => {
  it('snapshot exposes queueEnabled, defaulting to true', async () => {
    const { store } = mockStore();
    const handlers = createWebHandlers(store);
    const out = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    assert.equal(out.ok, true);
    assert.equal(out.value.queueEnabled, true);
  });

  it('setQueueEnabled toggles the flag and refuses a non-boolean', async () => {
    const { store } = mockStore();
    const handlers = createWebHandlers(store);
    const off = await routeWebCall(handlers, 'setQueueEnabled', { sessionId: 'sess-a', enabled: false });
    assert.equal(off.ok, true);
    assert.equal(off.value.queueEnabled, false);
    assert.equal(off.value.promoted, null);
    assert.equal(off.value.task, null);
    const snapOff = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    assert.equal(snapOff.value.queueEnabled, false);
    const on = await routeWebCall(handlers, 'setQueueEnabled', { sessionId: 'sess-a', enabled: true });
    assert.equal(on.ok, true);
    assert.equal(on.value.queueEnabled, true);
    const bad = await routeWebCall(handlers, 'setQueueEnabled', { sessionId: 'sess-a', enabled: 'yes' });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'bad-enabled');
    assert.equal((await routeWebCall(handlers, 'setQueueEnabled', { enabled: false })).ok, false);
  });

  it('paused project: approve queues without spawning, start promotes and spawns', async () => {
    const { store } = mockStore();
    const spawned = [];
    const handlers = createWebHandlers(store, {
      ctx: { fake: true },
      spawnWorker: async ({ task }) => { spawned.push(task.id); return { sessionId: 'sess-worker-' + task.id }; },
    });
    await routeWebCall(handlers, 'setQueueEnabled', { sessionId: 'sess-a', enabled: false });
    const row = enqueue(store.getDb(), 1, { type: 'feature', title: 'Manual start', spec: '' });
    const approved = await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: row.id });
    assert.equal(approved.ok, true);
    assert.equal(approved.value.task.state, 'queued');
    assert.equal(approved.value.promoted, null);
    assert.deepEqual(spawned, [], 'a paused approve never spawns');
    const out = await routeWebCall(handlers, 'start', { sessionId: 'sess-a', id: row.id });
    assert.equal(out.ok, true);
    assert.equal(out.value.task.state, 'active');
    assert.equal(out.value.promoted.id, row.id);
    assert.equal(out.value.queueEnabled, false);
    assert.deepEqual(spawned, [row.id]);
    assert.deepEqual(out.value.spawn, { sessionId: 'sess-worker-' + row.id });
  });

  it('setQueueEnabled(true) promotes the FIFO head over the channel', async () => {
    const { store } = mockStore();
    const spawned = [];
    const handlers = createWebHandlers(store, {
      ctx: { fake: true },
      spawnWorker: async ({ task }) => { spawned.push(task.id); return { sessionId: 'sess-worker-' + task.id }; },
    });
    await routeWebCall(handlers, 'setQueueEnabled', { sessionId: 'sess-a', enabled: false });
    const first = enqueue(store.getDb(), 1, { type: 'bug', title: 'First', spec: '' });
    const second = enqueue(store.getDb(), 1, { type: 'bug', title: 'Second', spec: '' });
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: first.id });
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: second.id });
    const out = await routeWebCall(handlers, 'setQueueEnabled', { sessionId: 'sess-a', enabled: true });
    assert.equal(out.ok, true);
    assert.equal(out.value.promoted.id, first.id);
    assert.equal(out.value.task.id, first.id);
    assert.equal(out.value.task.state, 'active');
    assert.deepEqual(spawned, [first.id]);
  });

  it('start refuses a non-queued row and a busy slot', async () => {
    const { store } = mockStore();
    const handlers = createWebHandlers(store);
    const draft = enqueue(store.getDb(), 1, { type: 'bug', title: 'Draft', spec: '' });
    const bad = await routeWebCall(handlers, 'start', { sessionId: 'sess-a', id: draft.id });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'bad-state');
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: draft.id });
    const one = enqueue(store.getDb(), 1, { type: 'bug', title: 'One', spec: '' });
    const two = enqueue(store.getDb(), 1, { type: 'bug', title: 'Two', spec: '' });
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: one.id });
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: two.id });
    const busy = await routeWebCall(handlers, 'start', { sessionId: 'sess-a', id: two.id });
    assert.equal(busy.ok, false);
    assert.equal(busy.error.code, 'slot-busy');
    const snap = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    assert.equal(snap.value.tasks.find((t) => t.id === two.id).state, 'queued');
  });

  it('cross-workspace start and setQueueEnabled touch nothing', async () => {
    const { h, store, wsA } = mockStore();
    const handlers = createWebHandlers(store);
    const blocker = enqueue(h.db, wsA, { type: 'bug', title: 'Mine', spec: '' });
    approve(h.db, blocker.id);
    const waiting = enqueue(h.db, wsA, { type: 'bug', title: 'Next', spec: '' });
    approve(h.db, waiting.id); // stays queued: repo-a's slot is busy
    // sess-b belongs to repo-b: the repo-a number does not resolve there.
    const out = await routeWebCall(handlers, 'start', { sessionId: 'sess-b', id: waiting.id });
    assert.equal(out.ok, false);
    assert.equal(out.error.code, 'not-found');
    assert.equal(get(h.db, waiting.id).state, 'queued');
    // The switch is per project: sess-b pausing leaves repo-a automatic.
    const off = await routeWebCall(handlers, 'setQueueEnabled', { sessionId: 'sess-b', enabled: false });
    assert.equal(off.ok, true);
    const snapA = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    assert.equal(snapA.value.queueEnabled, true);
    // In repo-a the slot is taken by the blocker, so its own start rejects.
    const busy = await routeWebCall(handlers, 'start', { sessionId: 'sess-a', id: waiting.id });
    assert.equal(busy.ok, false);
    assert.equal(busy.error.code, 'slot-busy');
    h.close();
  });
});
