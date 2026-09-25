import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openMemory } from '../lib/db.js';
import { approve, appendNote, editDraft, enqueue, ensureWorkspace, get } from '../lib/queue.js';
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

  it('snapshot carries the notes log of the caller workspace only', async () => {
    // The panel reads notes off the snapshot row (no new RPC endpoint): the
    // full row already reaches it through list() + SELECT *.
    const { h, store, wsA, wsB } = mockStore();
    const handlers = createWebHandlers(store);
    const mine = enqueue(h.db, wsA, { type: 'bug', title: 'Mine', spec: '' });
    approve(h.db, mine.id);
    appendNote(h.db, mine.id, 'flagged: notes block is read-only');
    const theirs = enqueue(h.db, wsB, { type: 'bug', title: 'Theirs', spec: '' });
    approve(h.db, theirs.id);
    appendNote(h.db, theirs.id, 'other workspace note');
    const snapA = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    assert.equal(snapA.ok, true);
    assert.equal(snapA.value.tasks.length, 1);
    assert.match(snapA.value.tasks[0].notes, /^- \[.+\] flagged: notes block is read-only$/);
    // Workspace-scoped like every other read: repo-b's notes never leak.
    const snapB = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-b' });
    assert.equal(snapB.value.tasks.length, 1);
    assert.match(snapB.value.tasks[0].notes, /^- \[.+\] other workspace note$/);
    assert.doesNotMatch(snapB.value.tasks[0].notes, /read-only/);
    // A task without notes reads as an empty string, never null.
    const plain = enqueue(h.db, wsA, { type: 'chore', title: 'Plain', spec: '' });
    const again = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    const plainRow = again.value.tasks.find((t) => t.id === plain.id);
    assert.equal(plainRow.notes, '');
    h.close();
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

  it('modelRoutes returns providers when the llm service is present', async () => {
    const { store } = mockStore();
    const handlers = createWebHandlers(store, {
      ctx: {
        get: (key) => key === 'llm'
          ? {
              listProviders: () => [
                { id: 'deepseek', name: 'DeepSeek' },
                { id: 'openai', name: 'OpenAI' },
              ],
              listModels: async (provider) => {
                if (provider === 'deepseek') {
                  return [
                    { id: 'deepseek-chat', name: 'DeepSeek V3' },
                    { id: 'deepseek-reasoner', name: 'DeepSeek R1' },
                  ];
                }
                return [
                  { id: 'gpt-4o', name: 'GPT-4o' },
                ];
              },
            }
          : undefined,
      },
    });
    const out = await routeWebCall(handlers, 'modelRoutes', { sessionId: 'sess-a' });
    assert.equal(out.ok, true);
    assert.equal(out.value.providers.length, 2);
    assert.equal(out.value.providers[0].id, 'deepseek');
    assert.equal(out.value.providers[0].name, 'DeepSeek');
    assert.equal(out.value.providers[0].models.length, 2);
    assert.equal(out.value.providers[0].models[0].id, 'deepseek-chat');
    assert.equal(out.value.providers[0].models[0].name, 'DeepSeek V3');
    assert.equal(out.value.providers[1].id, 'openai');
    assert.equal(out.value.providers[1].models.length, 1);
    assert.equal(out.value.providers[1].models[0].id, 'gpt-4o');
  });

  it('modelRoutes falls back to an empty list when the llm service is absent', async () => {
    const { store } = mockStore();
    const handlers = createWebHandlers(store);
    const out = await routeWebCall(handlers, 'modelRoutes', { sessionId: 'sess-a' });
    assert.equal(out.ok, true);
    assert.deepEqual(out.value.providers, []);
  });

  it('modelRoutes is read-only: it does not touch queue state', async () => {
    const { h, store, wsA } = mockStore();
    const handlers = createWebHandlers(store);
    const row = enqueue(h.db, wsA, { type: 'bug', title: 'Still a draft', spec: '' });
    assert.equal(row.state, 'draft');
    const out = await routeWebCall(handlers, 'modelRoutes', { sessionId: 'sess-a' });
    assert.equal(out.ok, true);
    assert.equal(get(h.db, row.id).state, 'draft', 'the draft row is untouched');
    h.close();
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

describe('web RPC queued reorder (panel channel)', () => {
  // Paused project so approvals queue instead of promoting the head.
  async function queued(handlers, h, ws, titles) {
    await routeWebCall(handlers, 'setQueueEnabled', { sessionId: 'sess-a', enabled: false });
    const rows = titles.map((title) => enqueue(h.db, ws, { type: 'bug', title, spec: '' }));
    for (const row of rows) await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: row.id });
    return rows;
  }

  it('move returns the reordered queue and the moved task, promoting nothing', async () => {
    const { h, store, wsA } = mockStore();
    const handlers = createWebHandlers(store);
    const [one, two, three] = await queued(handlers, h, wsA, ['One', 'Two', 'Three']);
    const out = await routeWebCall(handlers, 'move', { sessionId: 'sess-a', id: three.id, direction: 'up' });
    assert.equal(out.ok, true);
    assert.equal(out.value.moved, true);
    assert.equal(out.value.task.id, three.id);
    assert.equal(out.value.promoted, null);
    assert.deepEqual(out.value.queued.map((t) => t.id), [one.id, three.id, two.id]);
    assert.equal(out.value.queueEnabled, false);
    const snap = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    assert.deepEqual(
      snap.value.tasks.filter((t) => t.state === 'queued').map((t) => t.id),
      [one.id, three.id, two.id]
    );
    h.close();
  });

  it('the moved task is the one the queue starts next', async () => {
    const { h, store, wsA } = mockStore();
    const spawned = [];
    const handlers = createWebHandlers(store, {
      ctx: { fake: true },
      spawnWorker: async ({ task }) => { spawned.push(task.id); return { sessionId: 'sess-worker-' + task.id }; },
    });
    const [one, two] = await queued(handlers, h, wsA, ['One', 'Two']);
    const out = await routeWebCall(handlers, 'move', { sessionId: 'sess-a', id: two.id, direction: 'up' });
    assert.equal(out.ok, true);
    assert.deepEqual(spawned, [], 'a reorder never spawns');
    const resumed = await routeWebCall(handlers, 'setQueueEnabled', { sessionId: 'sess-a', enabled: true });
    assert.equal(resumed.value.promoted.id, two.id);
    assert.deepEqual(spawned, [two.id]);
    assert.equal(get(h.db, one.id).state, 'queued');
    h.close();
  });

  it('edge moves are no-ops and bad input fails closed', async () => {
    const { h, store, wsA } = mockStore();
    const handlers = createWebHandlers(store);
    const [one, two] = await queued(handlers, h, wsA, ['One', 'Two']);
    const head = await routeWebCall(handlers, 'move', { sessionId: 'sess-a', id: one.id, direction: 'up' });
    assert.equal(head.ok, true);
    assert.equal(head.value.moved, false);
    assert.deepEqual(head.value.queued.map((t) => t.id), [one.id, two.id]);
    const badDir = await routeWebCall(handlers, 'move', { sessionId: 'sess-a', id: two.id, direction: 'top' });
    assert.equal(badDir.ok, false);
    assert.equal(badDir.error.code, 'bad-direction');
    const missing = await routeWebCall(handlers, 'move', { sessionId: 'sess-a', id: 999, direction: 'up' });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'not-found');
    assert.equal((await routeWebCall(handlers, 'move', { sessionId: 'sess-a', direction: 'up' })).ok, false);
    h.close();
  });

  it('cross-workspace and non-queued moves mutate nothing', async () => {
    const { h, store, wsA } = mockStore();
    const handlers = createWebHandlers(store);
    const [one, two] = await queued(handlers, h, wsA, ['One', 'Two']);
    const cross = await routeWebCall(handlers, 'move', { sessionId: 'sess-b', id: one.id, direction: 'down' });
    assert.equal(cross.ok, false);
    assert.equal(cross.error.code, 'not-found');
    const draft = enqueue(h.db, wsA, { type: 'bug', title: 'Still a draft', spec: '' });
    const notQueued = await routeWebCall(handlers, 'move', { sessionId: 'sess-a', id: draft.id, direction: 'up' });
    assert.equal(notQueued.ok, false);
    assert.equal(notQueued.error.code, 'bad-state');
    const snap = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    assert.deepEqual(snap.value.tasks.filter((t) => t.state === 'queued').map((t) => t.id), [one.id, two.id]);
    assert.equal(get(h.db, draft.id).state, 'draft');
    h.close();
  });
});

describe('web RPC unqueue (panel channel)', () => {
  // Paused project so approvals queue instead of promoting the head.
  async function queued(handlers, h, ws, titles) {
    await routeWebCall(handlers, 'setQueueEnabled', { sessionId: 'sess-a', enabled: false });
    const rows = titles.map((title) => enqueue(h.db, ws, { type: 'bug', title, spec: '' }));
    for (const row of rows) await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: row.id });
    return rows;
  }

  it('puts a queued task back to draft, promoting nothing and spawning nobody', async () => {
    const { h, store, wsA } = mockStore();
    const spawned = [];
    const handlers = createWebHandlers(store, {
      ctx: { fake: true },
      spawnWorker: async ({ task }) => { spawned.push(task.id); return { sessionId: 'sess-worker-' + task.id }; },
    });
    const [one, two, three] = await queued(handlers, h, wsA, ['One', 'Two', 'Three']);
    const out = await routeWebCall(handlers, 'unqueue', { sessionId: 'sess-a', id: two.id });
    assert.equal(out.ok, true);
    assert.equal(out.value.task.id, two.id);
    assert.equal(out.value.task.state, 'draft');
    assert.equal(out.value.task.queued_at, null);
    assert.equal(out.value.task.branch, '');
    assert.equal(out.value.promoted, null);
    assert.equal(out.value.queueEnabled, false);
    assert.equal(out.value.spawn, undefined, 'a revert never spawns a worker');
    assert.deepEqual(spawned, []);
    const snap = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    assert.deepEqual(snap.value.tasks.filter((t) => t.state === 'queued').map((t) => t.id), [one.id, three.id]);
    assert.equal(snap.value.tasks.filter((t) => t.state === 'active').length, 0);
    const draftRow = snap.value.tasks.find((t) => t.id === two.id);
    assert.equal(draftRow.state, 'draft');
    h.close();
  });

  it('leaves an active row untouched', async () => {
    const { h, store, wsA } = mockStore();
    const handlers = createWebHandlers(store);
    const blocker = enqueue(h.db, wsA, { type: 'bug', title: 'Blocker', spec: '' });
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: blocker.id }); // active
    const [one, two] = await queued(handlers, h, wsA, ['One', 'Two']);
    const out = await routeWebCall(handlers, 'unqueue', { sessionId: 'sess-a', id: two.id });
    assert.equal(out.ok, true);
    assert.equal(out.value.task.state, 'draft');
    const snap = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    assert.equal(get(h.db, blocker.id).state, 'active');
    assert.deepEqual(snap.value.tasks.filter((t) => t.state === 'active').map((t) => t.id), [blocker.id]);
    assert.deepEqual(snap.value.tasks.filter((t) => t.state === 'queued').map((t) => t.id), [one.id]);
    h.close();
  });

  it('cross-workspace and non-queued ids fail closed without mutating', async () => {
    const { h, store, wsA } = mockStore();
    const handlers = createWebHandlers(store);
    const [one, two] = await queued(handlers, h, wsA, ['One', 'Two']);
    const cross = await routeWebCall(handlers, 'unqueue', { sessionId: 'sess-b', id: one.id });
    assert.equal(cross.ok, false);
    assert.equal(cross.error.code, 'not-found');
    const draft = enqueue(h.db, wsA, { type: 'bug', title: 'Still a draft', spec: '' });
    const notQueued = await routeWebCall(handlers, 'unqueue', { sessionId: 'sess-a', id: draft.id });
    assert.equal(notQueued.ok, false);
    assert.equal(notQueued.error.code, 'bad-state');
    const badId = await routeWebCall(handlers, 'unqueue', { sessionId: 'sess-a' });
    assert.equal(badId.ok, false);
    assert.equal(badId.error.code, 'bad-id');
    const snap = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    assert.deepEqual(snap.value.tasks.filter((t) => t.state === 'queued').map((t) => t.id), [one.id, two.id]);
    assert.notEqual(get(h.db, one.id).queued_at, null);
    assert.equal(get(h.db, draft.id).state, 'draft');
    h.close();
  });

  it('the reverted task can be revised and re-enters at the end of the FIFO', async () => {
    const { h, store, wsA } = mockStore();
    const handlers = createWebHandlers(store);
    const [one, two, three] = await queued(handlers, h, wsA, ['One', 'Two', 'Three']);
    await routeWebCall(handlers, 'unqueue', { sessionId: 'sess-a', id: one.id });
    // Editable again through the same channel the intake uses (queue domain).
    const revised = editDraft(h.db, one.id, { title: 'One revised', spec: 'now editable' });
    assert.equal(revised.state, 'draft');
    const again = await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: one.id });
    assert.equal(again.ok, true);
    assert.equal(again.value.task.state, 'queued');
    const snap = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    assert.deepEqual(snap.value.tasks.filter((t) => t.state === 'queued').map((t) => t.id), [two.id, three.id, one.id]);
    h.close();
  });
});

describe('web RPC requeue (panel channel)', () => {
  it('sends an active task back to the queue and spawns the promoted head', async () => {
    const { h, store, wsA } = mockStore();
    const spawned = [];
    const handlers = createWebHandlers(store, {
      ctx: { fake: true },
      spawnWorker: async ({ task }) => { spawned.push(task.id); return { sessionId: 'sess-worker-' + task.id }; },
    });
    const blocker = enqueue(h.db, wsA, { type: 'bug', title: 'Blocker', spec: '' });
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: blocker.id });
    const one = enqueue(h.db, wsA, { type: 'bug', title: 'One', spec: '' });
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: one.id });
    spawned.length = 0; // drop what the approvals above spawned
    const out = await routeWebCall(handlers, 'requeue', { sessionId: 'sess-a', id: blocker.id });
    assert.equal(out.ok, true);
    assert.equal(out.value.task.id, blocker.id);
    assert.equal(out.value.task.state, 'queued');
    assert.equal(out.value.task.branch, 'task/' + blocker.seq + '-blocker', 'the branch is kept');
    assert.equal(out.value.task.worker_session, null);
    assert.equal(out.value.promoted.id, one.id);
    assert.equal(out.value.promoted.state, 'active');
    assert.equal(out.value.queueEnabled, true);
    assert.deepEqual(spawned, [one.id], 'the promoted head gets a fresh worker');
    assert.deepEqual(out.value.spawn, { sessionId: 'sess-worker-' + one.id });
    const snap = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    assert.equal(snap.value.tasks.find((t) => t.id === blocker.id).state, 'queued');
    h.close();
  });

  it('a paused project promotes and spawns nobody', async () => {
    const { h, store, wsA } = mockStore();
    const spawned = [];
    const handlers = createWebHandlers(store, {
      ctx: { fake: true },
      spawnWorker: async ({ task }) => { spawned.push(task.id); return { sessionId: 'sess-worker-' + task.id }; },
    });
    await routeWebCall(handlers, 'setQueueEnabled', { sessionId: 'sess-a', enabled: false });
    const one = enqueue(h.db, wsA, { type: 'bug', title: 'One', spec: '' });
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: one.id });
    await routeWebCall(handlers, 'start', { sessionId: 'sess-a', id: one.id }); // active by hand
    const two = enqueue(h.db, wsA, { type: 'bug', title: 'Two', spec: '' });
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: two.id });
    spawned.length = 0; // drop the worker the manual start above spawned
    const out = await routeWebCall(handlers, 'requeue', { sessionId: 'sess-a', id: one.id });
    assert.equal(out.ok, true);
    assert.equal(out.value.task.state, 'queued');
    assert.equal(out.value.promoted, null);
    assert.equal(out.value.queueEnabled, false);
    assert.equal(out.value.spawn, undefined, 'a paused project spawns nobody');
    assert.deepEqual(spawned, []);
    const snap = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    assert.equal(snap.value.tasks.filter((t) => t.state === 'active').length, 0);
    assert.deepEqual(
      snap.value.tasks.filter((t) => t.state === 'queued').map((t) => t.id),
      [two.id, one.id],
      'the requeued row re-enters at the end of the FIFO'
    );
    h.close();
  });

  it('cross-workspace and non-active ids fail closed without mutating', async () => {
    const { h, store, wsA } = mockStore();
    const handlers = createWebHandlers(store);
    const row = enqueue(h.db, wsA, { type: 'bug', title: 'Mine', spec: '' });
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: row.id }); // active in repo-a
    const cross = await routeWebCall(handlers, 'requeue', { sessionId: 'sess-b', id: row.id });
    assert.equal(cross.ok, false);
    assert.equal(cross.error.code, 'not-found');
    assert.equal(get(h.db, row.id).state, 'active');
    const draft = enqueue(h.db, wsA, { type: 'bug', title: 'Still a draft', spec: '' });
    const notActive = await routeWebCall(handlers, 'requeue', { sessionId: 'sess-a', id: draft.id });
    assert.equal(notActive.ok, false);
    assert.equal(notActive.error.code, 'bad-state');
    const badId = await routeWebCall(handlers, 'requeue', { sessionId: 'sess-a' });
    assert.equal(badId.ok, false);
    assert.equal(badId.error.code, 'bad-id');
    assert.equal(get(h.db, draft.id).state, 'draft');
    assert.equal(get(h.db, draft.id).queued_at, null);
    const snap = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    assert.deepEqual(snap.value.tasks.filter((t) => t.state === 'active').map((t) => t.id), [row.id]);
    assert.equal(snap.value.tasks.filter((t) => t.state === 'queued').length, 0);
    h.close();
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

// The reported bug: in a DB where a workspace's internal ids have diverged from
// its per-workspace seq, the panel addressed a card by the internal id and the
// server resolved that number to whatever OTHER row carried it as a seq. The
// panel now sends the visible #N (task.seq), which is what these tests send.
describe('web RPC with diverged ids and seqs (panel addressing)', () => {
  // Two filler rows in repo-b push repo-a's ids above its seqs, so every
  // repo-a row has id = seq + 2. rows.get('a3') then reads naturally.
  function divergentStore() {
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
    // Spawner: binds the session so a promotion looks like the real host.
    const handlers = createWebHandlers(store, {
      ctx: { fake: true },
      spawnWorker: async ({ task }) => {
        const { bindSession } = await import('../lib/queue.js');
        bindSession(h.db, task.id, 'sess-worker-' + task.seq);
        return { sessionId: 'sess-worker-' + task.seq };
      },
    });
    for (const title of ['Filler one', 'Filler two']) {
      enqueue(h.db, wsB, { type: 'bug', title, spec: '' });
    }
    const rows = new Map();
    for (const title of ['Alpha', 'Beta', 'Gamma', 'Delta']) {
      const row = enqueue(h.db, wsA, { type: 'bug', title, spec: '' });
      rows.set(title.toLowerCase(), row);
    }
    return { h, store, handlers, wsA, wsB, rows };
  }

  it('fixture really diverges (id = seq + 2 in repo-a)', () => {
    const { h, rows } = divergentStore();
    const a = rows.get('alpha');
    const d = rows.get('delta');
    assert.deepEqual([a.id, a.seq, d.id, d.seq], [3, 1, 6, 4]);
    h.close();
  });

  it('approve acts on the card whose #N was sent, never the id twin', async () => {
    const { h, handlers, rows } = divergentStore();
    const alpha = rows.get('alpha'); // id 3, seq 1
    const gamma = rows.get('gamma'); // id 5, seq 3
    // #3 is alpha's internal id and gamma's visible seq: gamma must win.
    const out = await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: gamma.seq });
    assert.equal(out.ok, true);
    assert.equal(out.value.task.id, gamma.id);
    assert.equal(out.value.task.title, 'Gamma');
    assert.equal(out.value.promoted.id, gamma.id);
    assert.deepEqual(out.value.spawn, { sessionId: 'sess-worker-3' });
    assert.equal(get(h.db, alpha.id).state, 'draft');
    h.close();
  });

  it('close acts on the card whose #N was sent', async () => {
    const { h, handlers, rows } = divergentStore();
    const alpha = rows.get('alpha'); // id 3, seq 1
    const gamma = rows.get('gamma'); // id 5, seq 3
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: gamma.seq });
    const out = await routeWebCall(handlers, 'close', { sessionId: 'sess-a', id: gamma.seq, outcome: 'done' });
    assert.equal(out.ok, true);
    assert.equal(out.value.task.id, gamma.id);
    assert.equal(out.value.task.state, 'done');
    assert.equal(get(h.db, alpha.id).state, 'draft');
    h.close();
  });

  it('unqueue acts on the queued card whose #N was sent', async () => {
    const { h, handlers, rows } = divergentStore();
    const alpha = rows.get('alpha'); // slot holder, id 3, seq 1
    const gamma = rows.get('gamma'); // id 5, seq 3 -> queued behind alpha
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: alpha.seq });
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: gamma.seq });
    assert.equal(get(h.db, gamma.id).state, 'queued');
    const out = await routeWebCall(handlers, 'unqueue', { sessionId: 'sess-a', id: gamma.seq });
    assert.equal(out.ok, true);
    assert.equal(out.value.task.id, gamma.id);
    assert.equal(get(h.db, gamma.id).state, 'draft');
    // alpha keeps the slot: the wrong row was not pulled out.
    assert.equal(get(h.db, alpha.id).state, 'active');
    h.close();
  });

  it('move acts on the queued card whose #N was sent', async () => {
    const { h, handlers, rows } = divergentStore();
    const alpha = rows.get('alpha'); // slot holder
    const beta = rows.get('beta'); // id 4, seq 2
    const gamma = rows.get('gamma'); // id 5, seq 3
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: alpha.seq });
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: beta.seq });
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: gamma.seq });
    // Queued order is [beta, gamma]: move #3 (gamma) up.
    const out = await routeWebCall(handlers, 'move', { sessionId: 'sess-a', id: gamma.seq, direction: 'up' });
    assert.equal(out.ok, true);
    assert.equal(out.value.task.id, gamma.id);
    const listed = await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-a' });
    const queued = listed.value.tasks.filter((t) => t.state === 'queued');
    assert.deepEqual(queued.map((t) => t.title), ['Gamma', 'Beta']);
    h.close();
  });

  it('requeue acts on the active card whose #N was sent', async () => {
    const { h, handlers, rows } = divergentStore();
    const alpha = rows.get('alpha'); // id 3, seq 1 -> active
    const beta = rows.get('beta'); // id 4, seq 2
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: alpha.seq });
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: beta.seq });
    const out = await routeWebCall(handlers, 'requeue', { sessionId: 'sess-a', id: alpha.seq });
    assert.equal(out.ok, true);
    assert.equal(out.value.task.id, alpha.id);
    assert.equal(out.value.task.state, 'queued');
    // Freeing the slot promoted the FIFO head (beta), not the row whose id
    // equals alpha's seq.
    assert.equal(get(h.db, beta.id).state, 'active');
    h.close();
  });

  it('start promotes the queued card whose #N was sent (paused project)', async () => {
    const { h, handlers, rows, wsA } = divergentStore();
    const alpha = rows.get('alpha'); // id 3, seq 1
    const gamma = rows.get('gamma'); // id 5, seq 3
    await routeWebCall(handlers, 'setQueueEnabled', { sessionId: 'sess-a', enabled: false });
    // Paused: approve only queues, so both rows wait.
    await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: gamma.seq });
    assert.equal(get(h.db, gamma.id).state, 'queued');
    const out = await routeWebCall(handlers, 'start', { sessionId: 'sess-a', id: gamma.seq });
    assert.equal(out.ok, true);
    assert.equal(out.value.task.id, gamma.id);
    assert.equal(get(h.db, gamma.id).state, 'active');
    assert.equal(get(h.db, alpha.id).state, 'draft');
    h.close();
  });

  it('a number that names no seq of the workspace still resolves by id', async () => {
    const { h, handlers, rows } = divergentStore();
    const delta = rows.get('delta'); // id 6, seq 4: no repo-a row has seq 6
    const out = await routeWebCall(handlers, 'approve', { sessionId: 'sess-a', id: delta.id });
    assert.equal(out.ok, true);
    assert.equal(out.value.task.id, delta.id);
    assert.equal(out.value.task.title, 'Delta');
    h.close();
  });

  it('a repo-b number resolves to nothing in repo-a', async () => {
    const { h, handlers, rows, wsB } = divergentStore();
    const beta = rows.get('beta'); // repo-a row, id 4, seq 2
    const out = await routeWebCall(handlers, 'approve', { sessionId: 'sess-b', id: beta.id });
    assert.equal(out.ok, false);
    assert.equal(out.error.code, 'not-found');
    assert.equal(get(h.db, beta.id).state, 'draft');
    // repo-b's own #1 resolves inside repo-b.
    const b = (await routeWebCall(handlers, 'snapshot', { sessionId: 'sess-b' })).value.tasks[0];
    assert.equal(b.seq, 1);
    assert.ok(b.workspace_id === wsB);
    h.close();
  });
});

// The manual GitHub updater: three deployment-wide endpoints (lib/updater.js)
// mounted through hooks.updater. They need no sessionId and touch no queue row.
describe('web RPC updater endpoints', () => {
  function fakeUpdater(overrides = {}) {
    const seen = [];
    const updater = async (endpoint, payload) => {
      seen.push({ endpoint, payload });
      const answer = overrides[endpoint];
      return answer === undefined ? { ok: true, value: { endpoint } } : await answer(payload);
    };
    return { updater, seen };
  }

  it('routes updateStatus without a sessionId', async () => {
    const { store } = mockStore();
    const { updater, seen } = fakeUpdater({
      updateStatus: async () => ({ ok: true, value: { repository: 'necos98/dsh-tasks-manager', current: '0.1.0' } }),
    });
    const handlers = createWebHandlers(store, { updater });
    const out = await routeWebCall(handlers, 'updateStatus', {});
    assert.equal(out.ok, true);
    assert.equal(out.value.current, '0.1.0');
    assert.deepEqual(seen, [{ endpoint: 'updateStatus', payload: {} }]);
  });

  it('routes checkUpdate and applyUpdate with their payloads', async () => {
    const { store } = mockStore();
    const { updater, seen } = fakeUpdater({
      checkUpdate: async () => ({ ok: true, value: { status: 'update-available', current: '0.1.0', latest: 'v0.1.1' } }),
      applyUpdate: async (payload) => ({ ok: true, value: { restartRequired: true, force: payload.force === true } }),
    });
    const handlers = createWebHandlers(store, { updater });
    const check = await routeWebCall(handlers, 'checkUpdate', {});
    assert.equal(check.value.status, 'update-available');
    const applied = await routeWebCall(handlers, 'applyUpdate', { force: true });
    assert.equal(applied.ok, true);
    assert.equal(applied.value.force, true);
    assert.equal(applied.value.restartRequired, true);
    assert.deepEqual(seen.map((s) => s.endpoint), ['checkUpdate', 'applyUpdate']);
  });

  it('answers "the updater is not mounted" when no updater is injected', async () => {
    const { store } = mockStore();
    const handlers = createWebHandlers(store);
    for (const endpoint of ['updateStatus', 'checkUpdate', 'applyUpdate']) {
      const out = await routeWebCall(handlers, endpoint, {});
      assert.equal(out.ok, false);
      assert.equal(out.error.code, 'internal');
      assert.match(out.error.message, /the updater is not mounted/);
    }
  });

  it('turns an updater failure into an answer, never a rejection', async () => {
    const { store } = mockStore();
    const handlers = createWebHandlers(store, {
      updater: async () => ({ ok: false, error: { code: 'bad-request', message: 'nothing to update', details: {} } }),
    });
    const refused = await routeWebCall(handlers, 'applyUpdate', {});
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'bad-request');
    const handlersThatThrow = createWebHandlers(store, {
      updater: async () => { throw new Error('boom'); },
    });
    const thrown = await routeWebCall(handlersThatThrow, 'checkUpdate', {});
    assert.equal(thrown.ok, false);
    assert.equal(thrown.error.message, 'boom');
  });
});
