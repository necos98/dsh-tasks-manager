import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnWorker, workerPrompt } from '../lib/spawn.js';
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
