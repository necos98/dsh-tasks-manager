import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { modesOfCtx, spawnForPromotion, spawnWorker, workerPrompt } from '../lib/spawn.js';
import { bindSession, enqueue, ensureWorkspace, get } from '../lib/queue.js';
import { openMemory } from '../lib/db.js';

// Regression: the first spawn built the inbox message by hand
// ({ role, content, source } with no id). It read fine live but persisted
// an id-less user/message; after restart the load validation rejected the
// whole chat ("session event at seq 8 lacks an identified message").
// The spawn must ALWAYS send an identified message (official prompt path
// or a local UUID fallback — never id-less).
describe('spawn identified prompt', () => {
  function mockCtx(captured) {
    return {
      get(key) {
        if (key === 'agents') {
          return {
            create: async ({ sessionId }) => ({
              agent: {
                session: { id: sessionId },
                followup: (msg) => { captured.followup = msg; },
              },
            }),
          };
        }
        if (key === 'workspaceRegistry') return { get: () => undefined };
        // No sessionController / agentDefaultModel / presets:
        // exercises the local fallback chain.
        return undefined;
      },
    };
  }

  it('workerPrompt is English and names id/title/branch', () => {
    const text = workerPrompt({ id: 7, title: 'Fix login', branch: 'task/7-fix-login', slug: 'fix-login' });
    assert.match(text, /task #7/);
    assert.match(text, /Fix login/);
    assert.match(text, /task\/7-fix-login/);
  });

  it('workerPrompt uses the visible seq when the row carries one', () => {
    const text = workerPrompt({ id: 9, seq: 2, title: 'Fix login', branch: 'task/2-fix-login', slug: 'fix-login' });
    assert.match(text, /task #2/);
    assert.match(text, /task\/2-fix-login/);
    assert.doesNotMatch(text, /#9/);
  });

  it('workerPrompt defaults to manual modes (never touch base)', () => {
    const text = workerPrompt({ id: 7, title: 'Fix login', branch: 'task/7-fix-login', slug: 'fix-login' });
    assert.match(text, /auto-merge is OFF/);
    assert.match(text, /self-finish is OFF/);
    assert.match(text, /NEVER touch the base branch/);
  });

  it('workerPrompt states ON modes explicitly when enabled', () => {
    const text = workerPrompt(
      { id: 7, title: 'Fix login', branch: 'task/7-fix-login', slug: 'fix-login' },
      { workerCanMerge: true, workerCanFinish: true },
    );
    assert.match(text, /auto-merge is ON/);
    assert.match(text, /self-finish is ON/);
    assert.match(text, /--no-ff/);
    assert.match(text, /any conflict aborts/);
  });

  it('modesOfCtx reads the toggles, safe on missing pieces', () => {
    assert.deepEqual(modesOfCtx(undefined), { workerCanFinish: false, workerCanMerge: false });
    assert.deepEqual(modesOfCtx({ get: () => undefined }), { workerCanFinish: false, workerCanMerge: false });
    assert.deepEqual(
      modesOfCtx({ get: (k) => k === 'settings' ? { get: () => ({ workerCanMerge: true }) } : undefined }),
      { workerCanFinish: false, workerCanMerge: true },
    );
  });

  it('spawnWorker tells the worker its modes in the first prompt', async () => {
    const h = openMemory();
    const ws = ensureWorkspace(h.db, 'C:/repo-a');
    const row = enqueue(h.db, ws, { type: 'bug', title: 'Modes', spec: '' });
    h.db.prepare('UPDATE tasks SET state = ? WHERE id = ?').run('active', row.id);
    const captured = {};
    const ctx = {
      get(key) {
        if (key === 'agents') {
          return {
            create: async ({ sessionId }) => ({
              agent: {
                session: { id: sessionId },
                followup: (msg) => { captured.followup = msg; },
              },
            }),
          };
        }
        if (key === 'settings') return { get: () => ({ workerCanMerge: true, workerCanFinish: false }) };
        return undefined;
      },
    };
    await spawnWorker({ ctx, db: h.db, workspace: { id: 'a', path: 'C:/repo-a' }, task: get(h.db, row.id) });
    const text = captured.followup.content.map((b) => b.text).join('\n');
    assert.match(text, /auto-merge is ON/);
    assert.match(text, /self-finish is OFF/);
    h.close();
  });

  it('spawnForPromotion no-ops without a promotion or on stale rows', async () => {
    const h = openMemory();
    const ws = ensureWorkspace(h.db, 'C:/repo-a');
    const ctx = { get: () => undefined };
    assert.equal(await spawnForPromotion({ ctx, db: h.db, workspace: { id: 'a', path: 'C:/repo-a' }, promoted: null }), undefined);
    assert.equal(await spawnForPromotion({ ctx, db: h.db, workspace: { id: 'a', path: 'C:/repo-a' }, promoted: undefined }), undefined);
    const row = enqueue(h.db, ws, { type: 'bug', title: 'Queued', spec: '' });
    // Still queued: stale promotion shape must not spawn.
    let called = false;
    const noSpawn = await spawnForPromotion({ ctx, db: h.db, workspace: { id: 'a', path: 'C:/repo-a' }, promoted: { id: row.id } });
    assert.equal(noSpawn, undefined);
    assert.equal(called, false);
    h.close();
  });

  it('spawnForPromotion returns the error instead of throwing', async () => {
    const h = openMemory();
    const ws = ensureWorkspace(h.db, 'C:/repo-a');
    const row = enqueue(h.db, ws, { type: 'bug', title: 'Active', spec: '' });
    h.db.prepare('UPDATE tasks SET state = ? WHERE id = ?').run('active', row.id);
    // No agents service: spawnWorker throws -> spawnForPromotion returns { error }.
    const out = await spawnForPromotion({
      ctx: { get: () => undefined },
      db: h.db,
      workspace: { id: 'a', path: 'C:/repo-a' },
      promoted: { id: row.id },
    });
    assert.match(out.error, /agents service unavailable/);
    // The promotion stands: still active, unbound (lazy bind remains available).
    assert.equal(get(h.db, row.id).state, 'active');
    h.close();
  });

  it('followup message always carries a non-empty id', async () => {
    const h = openMemory();
    const ws = ensureWorkspace(h.db, 'C:/repo-a');
    const row = enqueue(h.db, ws, { type: 'bug', title: 'Identified', spec: '' });
    // Promote to active like approve does (spawn needs the active row).
    h.db.prepare('UPDATE tasks SET state = ? WHERE id = ?').run('active', row.id);
    const active = get(h.db, row.id);
    const captured = {};
    const ctx = mockCtx(captured);
    const out = await spawnWorker({
      ctx,
      db: h.db,
      workspace: { id: 'a', path: 'C:/repo-a' },
      task: active,
    });
    assert.ok(
      typeof out.sessionId === 'string' && out.sessionId.startsWith('session-'),
      'spawn returns the created session id, got: ' + JSON.stringify(out.sessionId),
    );
    assert.ok(captured.followup, 'followup was called');
    assert.equal(captured.followup.role, 'user');
    assert.ok(
      typeof captured.followup.id === 'string' && captured.followup.id !== '',
      'prompt message must be identified, got: ' + JSON.stringify(captured.followup.id),
    );
    // And the session got bound.
    assert.equal(get(h.db, row.id).worker_session, out.sessionId);
    void bindSession;
    h.close();
  });
});
