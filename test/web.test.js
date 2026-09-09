import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openMemory } from '../lib/db.js';
import { enqueue, ensureWorkspace } from '../lib/queue.js';
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
});
