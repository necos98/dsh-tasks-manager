import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openMemory } from '../lib/db.js';
import { approve, close, enqueue, ensureWorkspace } from '../lib/queue.js';
import { makeToolDefinitions } from '../lib/tools.js';

// Mock store: in-memory DB + fake two-workspace registry. No DSH boot needed.
function mockStore() {
  const h = openMemory();
  const wsA = ensureWorkspace(h.db, 'C:/repo-a');
  const wsB = ensureWorkspace(h.db, 'C:/repo-b');
  const store = {
    getDb() { return h.db; },
    workspaceRegistry: {
      list() {
        return [
          { id: 'a', path: 'C:/repo-a', sessionIds: ['sess-a'] },
          { id: 'b', path: 'C:/repo-b', sessionIds: ['sess-b'] },
        ];
      },
    },
  };
  return { h, store, wsA, wsB };
}

const execA = { agent: { session: { header: { id: 'sess-a' } } } };
const execB = { agent: { session: { header: { id: 'sess-b' } } } };

function byName(defs, name) {
  const d = defs.find((t) => t.name === name);
  assert.ok(d, 'tool ' + name + ' registered');
  return d;
}

describe('tool registration (FIX-02)', () => {
  it('registers 10 tools with output { schema, render }', () => {
    const { store } = mockStore();
    const defs = makeToolDefinitions(store);
    assert.equal(defs.length, 10);
    for (const d of defs) {
      assert.ok(d.output && typeof d.output === 'object', d.name + ' has output');
      assert.equal(typeof d.output.render, 'function', d.name + ' has render fn');
      assert.ok(d.output.schema && d.output.schema.type, d.name + ' has schema');
    }
  });

  it('parameters compile to object schemas with required lists (defineTool)', () => {
    const { store } = mockStore();
    const defs = makeToolDefinitions(store);
    // defineTool compiles the per-property author form ({ id: { type, required } })
    // into standard JSON Schema ({ properties, required: [...] }).
    const enc = byName(defs, 'enqueue_task');
    assert.equal(enc.parameters.type, 'object');
    assert.ok(enc.parameters.required.includes('type'));
    assert.ok(enc.parameters.required.includes('title'));
    assert.ok(byName(defs, 'approve_task').parameters.required.includes('id'));
    const close = byName(defs, 'close_task');
    assert.ok(close.parameters.required.includes('id'));
    assert.ok(close.parameters.required.includes('outcome'));
    assert.ok(byName(defs, 'search_tasks').parameters.required.includes('query'));
    const finish = byName(defs, 'finish_task');
    assert.ok(finish.parameters.required.includes('outcome'));
    assert.deepEqual(finish.parameters.properties.outcome.enum, ['done', 'failed']);
    const edit = byName(defs, 'edit_draft');
    assert.ok(edit.parameters.required.includes('id'));
    assert.ok(!edit.parameters.required.includes('title'));
    assert.ok(!edit.parameters.required.includes('spec'));
    assert.ok(!edit.parameters.required.includes('type'));
    assert.deepEqual(edit.parameters.properties.type.enum, ['feature', 'bug', 'refactor', 'chore']);
    assert.ok(edit.output && edit.output.schema && edit.output.schema.type, 'edit_draft has schema');
    assert.equal(typeof edit.output.render, 'function', 'edit_draft has render fn');
    // note_task takes ONLY the body: the target is the session's bound task.
    const note = byName(defs, 'note_task');
    assert.deepEqual(note.parameters.required, ['text']);
    assert.ok(!('id' in note.parameters.properties), 'note_task has no id parameter');
  });
});

describe('tool execute (structured values + render)', () => {
  it('enqueue_task returns the row; render says draft', async () => {
    const { store } = mockStore();
    const defs = makeToolDefinitions(store);
    const t = byName(defs, 'enqueue_task');
    const v = await t.execute({ type: 'bug', title: 'Login mobile', spec: 'x' }, execA);
    assert.equal(v.state, 'draft');
    assert.equal(v.title, 'Login mobile');
    const [c] = t.output.render({ type: 'bug', title: 'Login mobile' }, v);
    assert.match(c.text, /^draft #\d+ \[draft\]/);
  });

  it('edit_draft revises title/spec/type on a draft with recomputed slug', async () => {
    const { h, store } = mockStore();
    const defs = makeToolDefinitions(store);
    const edit = byName(defs, 'edit_draft');
    const v = await byName(defs, 'enqueue_task').execute({ type: 'bug', title: 'Login mobile', spec: 'old' }, execA);
    const renamed = await edit.execute({ id: v.id, title: 'Login desktop' }, execA);
    assert.equal(renamed.title, 'Login desktop');
    assert.equal(renamed.slug, 'login-desktop');
    assert.equal(renamed.type, 'bug');
    assert.equal(renamed.spec, 'old');
    const respec = await edit.execute({ id: v.seq, spec: '' }, execA);
    assert.equal(respec.spec, '');
    assert.equal(respec.title, 'Login desktop');
    const retyped = await edit.execute({ id: v.seq, type: 'feature' }, execA);
    assert.equal(retyped.type, 'feature');
    assert.equal(retyped.title, 'Login desktop');
    const [c] = edit.output.render({ id: v.id, title: 'Login desktop' }, retyped);
    assert.match(c.text, /^edited #\d+ \[draft\]/);
    h.close();
  });

  it('edit_draft on a non-draft rejects with bad-state', async () => {
    const { h, store } = mockStore();
    const defs = makeToolDefinitions(store);
    const v = await byName(defs, 'enqueue_task').execute({ type: 'bug', title: 'Mine' }, execA);
    await byName(defs, 'approve_task').execute({ id: v.id }, execA);
    await assert.rejects(() => byName(defs, 'edit_draft').execute({ id: v.id, title: 'Late' }, execA), /only drafts can be edited/);
    const { get } = await import('../lib/queue.js');
    assert.equal(get(h.db, v.id).title, 'Mine');
    h.close();
  });

  it('edit_draft cross-workspace mutates nothing', async () => {
    const { h, store, wsA, wsB } = mockStore();
    const defs = makeToolDefinitions(store);
    enqueue(h.db, wsB, { type: 'bug', title: 'B first' }); // global id 1, seq 1 in B
    const a1 = enqueue(h.db, wsA, { type: 'bug', title: 'A first' }); // global id 2, seq 1 in A
    const a2 = enqueue(h.db, wsA, { type: 'bug', title: 'A second' }); // global id 3, seq 2 in A
    const edit = byName(defs, 'edit_draft');
    // 2 and 3 are A's global ids / seqs of A rows: invisible from B.
    await assert.rejects(() => edit.execute({ id: 2, title: 'Hijack' }, execB), /no task #2 here/);
    await assert.rejects(() => edit.execute({ id: 3, title: 'Hijack' }, execB), /no task #3 here/);
    const { get } = await import('../lib/queue.js');
    assert.equal(get(h.db, a1.id).title, 'A first');
    assert.equal(get(h.db, a2.id).title, 'A second');
    h.close();
  });

  it('tool text shows the per-workspace number, not the global id', async () => {
    const { h, store, wsA, wsB } = mockStore();
    const defs = makeToolDefinitions(store);
    const t = byName(defs, 'enqueue_task');
    enqueue(h.db, wsB, { type: 'bug', title: 'Other workspace first' }); // global id 1
    const v = await t.execute({ type: 'bug', title: 'Mine', spec: '' }, execA); // global id 2, seq 1
    assert.equal(v.id, 2);
    assert.equal(v.seq, 1);
    const [c] = t.output.render({ type: 'bug', title: 'Mine' }, v);
    assert.match(c.text, /^draft #1 \[draft\]/);
    assert.doesNotMatch(c.text, /#2/);
    const [l] = byName(defs, 'list_tasks').output.render({}, [v]);
    assert.match(l.text, /^#1 \[draft\]/);
    h.close();
  });

  it('an ambiguous number hits the visible #N, not the row whose id equals it', async () => {
    const { h, store, wsA, wsB } = mockStore();
    const defs = makeToolDefinitions(store);
    // wsB consumes the low ids, so wsA's ids and seqs diverge (the real shape
    // of a multi-workspace DB: id != seq in every row).
    enqueue(h.db, wsB, { type: 'bug', title: 'Other workspace first' }); // global id 1
    const first = await byName(defs, 'enqueue_task').execute({ type: 'bug', title: 'Mine' }, execA); // id 2, seq 1
    const second = await byName(defs, 'enqueue_task').execute({ type: 'feature', title: 'Second' }, execA); // id 3, seq 2
    assert.deepEqual([first.id, second.id], [2, 3]);
    assert.deepEqual([first.seq, second.seq], [1, 2]);
    // #2 is FIRST's internal id and SECOND's visible seq. Every display
    // surface (list_tasks, search_tasks, the panel card) calls it #2 = Second,
    // so #2 must address Second. Before the fix this returned First.
    const detail = await byName(defs, 'task_detail').execute({ id: 2 }, execA);
    assert.equal(detail.title, 'Second');
    assert.equal(detail.seq, 2);
    const edited = await byName(defs, 'edit_draft').execute({ id: 2, title: 'Second renamed' }, execA);
    assert.equal(edited.id, second.id);
    assert.equal(edited.title, 'Second renamed');
    const approved = await byName(defs, 'approve_task').execute({ id: 2 }, execA);
    assert.equal(approved.task.title, 'Second renamed');
    assert.match(approved.task.branch, /^task\/2-second-renamed/);
    const closed = await byName(defs, 'close_task').execute({ id: 2, outcome: 'done' }, execA);
    assert.equal(closed.task.title, 'Second renamed');
    // First was shadowed by the collision before the fix: it must be untouched.
    const { get } = await import('../lib/queue.js');
    assert.equal(get(h.db, first.id).title, 'Mine');
    assert.equal(get(h.db, first.id).state, 'draft');
    // list_tasks prints the same #2 the tools just addressed.
    const listed = await byName(defs, 'list_tasks').execute({}, execA);
    assert.match(byName(defs, 'list_tasks').output.render({}, listed)[0].text, /^#2 \[done\] Second renamed/m);
    h.close();
  });

  it('an id beyond the workspace seq range still resolves by id (back-compat)', async () => {
    const { h, store, wsA, wsB } = mockStore();
    const defs = makeToolDefinitions(store);
    // wsB burns ids 1-3, so wsA gets id 4 / seq 1.
    enqueue(h.db, wsB, { type: 'bug', title: 'B one' });
    enqueue(h.db, wsB, { type: 'bug', title: 'B two' });
    enqueue(h.db, wsB, { type: 'bug', title: 'B three' });
    const v = await byName(defs, 'enqueue_task').execute({ type: 'bug', title: 'Mine' }, execA);
    assert.equal(v.id, 4);
    assert.equal(v.seq, 1);
    // 4 is not any seq of wsA, so the internal id resolves it (older callers).
    const detail = await byName(defs, 'task_detail').execute({ id: 4 }, execA);
    assert.equal(detail.title, 'Mine');
    // The mutation path takes the same id and reaches the same row.
    const approved = await byName(defs, 'approve_task').execute({ id: 4 }, execA);
    assert.equal(approved.task.id, v.id);
    assert.equal(approved.task.state, 'active');
    const closed = await byName(defs, 'close_task').execute({ id: 4, outcome: 'done' }, execA);
    assert.equal(closed.task.state, 'done');
    h.close();
  });

  it('task_detail renders the visible number and leaks no internal identity', async () => {
    const { h, store, wsA, wsB } = mockStore();
    const defs = makeToolDefinitions(store);
    enqueue(h.db, wsB, { type: 'bug', title: 'Other' }); // global id 1
    const v = await byName(defs, 'enqueue_task').execute({ type: 'bug', title: 'Mine', spec: 'x' }, execA); // id 2, seq 1
    assert.equal(v.id, 2);
    const detail = byName(defs, 'task_detail');
    const row = await detail.execute({ id: 1 }, execA);
    // Validation still runs on the full row...
    assert.equal(row.id, v.id);
    const [c] = detail.output.render({ id: 1 }, row);
    const parsed = JSON.parse(c.text);
    // ...but the rendered text exposes the visible number only.
    assert.equal(parsed.seq, 1);
    assert.equal(parsed.title, 'Mine');
    assert.equal(parsed.id, undefined);
    assert.equal(parsed.workspace_id, undefined);
    assert.doesNotMatch(c.text, /"id"/);
    assert.doesNotMatch(c.text, /"workspace_id"/);
    h.close();
  });

  it('cross-workspace numbers (id or seq) mutate nothing', async () => {
    const { h, store, wsA, wsB } = mockStore();
    const defs = makeToolDefinitions(store);
    enqueue(h.db, wsB, { type: 'bug', title: 'B first' }); // global id 1, seq 1 in B
    const a1 = enqueue(h.db, wsA, { type: 'bug', title: 'A first' }); // global id 2, seq 1 in A
    const a2 = enqueue(h.db, wsA, { type: 'bug', title: 'A second' }); // global id 3, seq 2 in A
    const approveTool = byName(defs, 'approve_task');
    // 2 and 3 are A's global ids / seqs of A rows: invisible from B.
    await assert.rejects(() => approveTool.execute({ id: 2 }, execB), /no task #2 here/);
    await assert.rejects(() => approveTool.execute({ id: 3 }, execB), /no task #3 here/);
    const { get } = await import('../lib/queue.js');
    assert.equal(get(h.db, a1.id).state, 'draft');
    assert.equal(get(h.db, a2.id).state, 'draft');
    h.close();
  });

  it('list_tasks joins rows with newline, empty reads no tasks (FIX-03)', async () => {
    const { store, wsA } = mockStore();
    const defs = makeToolDefinitions(store);
    const l = byName(defs, 'list_tasks');
    const empty = await l.execute({}, execA);
    assert.deepEqual(empty, []);
    assert.equal(l.output.render({}, empty)[0].text, 'no tasks');
    enqueue(store.getDb(), wsA, { type: 'bug', title: 'One' });
    enqueue(store.getDb(), wsA, { type: 'bug', title: 'Two' });
    const rows = await l.execute({}, execA);
    assert.equal(rows.length, 2);
    const text = l.output.render({}, rows)[0].text;
    assert.ok(text.includes('\n'), 'rows joined with newline, got: ' + text);
  });

  it('approve/close verify ownership BEFORE mutating (FIX-07a)', async () => {
    const { h, store, wsA } = mockStore();
    const defs = makeToolDefinitions(store);
    const t = enqueue(h.db, wsA, { type: 'bug', title: 'Mine' });
    const approveTool = byName(defs, 'approve_task');
    await assert.rejects(() => approveTool.execute({ id: t.id }, execB), /no task #\d+ here/);
    // Nothing mutated: still draft in workspace A.
    const { get } = await import('../lib/queue.js');
    assert.equal(get(h.db, t.id).state, 'draft');
    // Owner approve works and returns { task, promoted }.
    const r = await approveTool.execute({ id: t.id }, execA);
    assert.ok(r.task && 'promoted' in r);
    assert.equal(r.task.state, 'active');
    // Cross-workspace close also mutates nothing.
    const closeTool = byName(defs, 'close_task');
    await assert.rejects(() => closeTool.execute({ id: t.id, outcome: 'done' }, execB), /no task/);
    assert.equal(get(h.db, t.id).state, 'active');
    h.close();
  });

  it('get_my_task lazy-binds the first worker read, no approver bind (FIX-07b)', async () => {
    const { h, store, wsA } = mockStore();
    const defs = makeToolDefinitions(store);
    const t = enqueue(h.db, wsA, { type: 'bug', title: 'Work' });
    // Approve from a session with no worker identity bound anywhere: task must
    // stay unbound (the approver is the user, not the worker).
    await byName(defs, 'approve_task').execute({ id: t.id }, execA);
    const { get } = await import('../lib/queue.js');
    assert.equal(get(h.db, t.id).worker_session, null);
    // First worker read binds sess-b... but sess-b is workspace B: not-found.
    await assert.rejects(() => byName(defs, 'get_my_task').execute({}, execB), /not-bound|no active task/);
    // Same-workspace second session binds on first read.
    store.workspaceRegistry.list = () => [
      { id: 'a', path: 'C:/repo-a', sessionIds: ['sess-a', 'sess-worker'] },
      { id: 'b', path: 'C:/repo-b', sessionIds: ['sess-b'] },
    ];
    const execW = { agent: { session: { header: { id: 'sess-worker' } } } };
    const mine = await byName(defs, 'get_my_task').execute({}, execW);
    assert.equal(mine.id, t.id);
    assert.equal(get(h.db, t.id).worker_session, 'sess-worker');
    // Second read returns the bound task.
    const again = await byName(defs, 'get_my_task').execute({}, execW);
    assert.equal(again.id, t.id);
    h.close();
  });

  it('finish_task closes only the caller-bound active task', async () => {
    const { h, store, wsA } = mockStore();
    const defs = makeToolDefinitions(store);
    const finish = byName(defs, 'finish_task');
    // No bound task: sess-a approved but never bound as worker.
    const t = enqueue(h.db, wsA, { type: 'bug', title: 'Mine' });
    await byName(defs, 'approve_task').execute({ id: t.id }, execA);
    await assert.rejects(() => finish.execute({ outcome: 'done' }, execA), /no active task bound/);
    // Bind sess-worker (same workspace) and finish as done.
    store.workspaceRegistry.list = () => [
      { id: 'a', path: 'C:/repo-a', sessionIds: ['sess-a', 'sess-worker'] },
      { id: 'b', path: 'C:/repo-b', sessionIds: ['sess-b'] },
    ];
    const execW = { agent: { session: { header: { id: 'sess-worker' } } } };
    await byName(defs, 'get_my_task').execute({}, execW);
    const done = await finish.execute({ outcome: 'done' }, execW);
    assert.equal(done.task.state, 'done');
    // A second finish finds nothing bound anymore.
    await assert.rejects(() => finish.execute({ outcome: 'done' }, execW), /no active task bound/);
    // Failed path on a fresh task: invalid outcome rejected by schema.
    const t2 = enqueue(h.db, wsA, { type: 'bug', title: 'Stuck' });
    await byName(defs, 'approve_task').execute({ id: t2.id }, execA);
    await byName(defs, 'get_my_task').execute({}, execW);
    await assert.rejects(() => finish.execute({ outcome: 'cancelled' }, execW), /must be one of|INVALID_ARGS/);
    const failed = await finish.execute({ outcome: 'failed' }, execW);
    assert.equal(failed.task.state, 'failed');
    h.close();
  });

  it('note_task appends to the session-bound active task and reports the entry count', async () => {
    const { h, store, wsA } = mockStore();
    const defs = makeToolDefinitions(store);
    const note = byName(defs, 'note_task');
    const { get } = await import('../lib/queue.js');
    // sess-a approved but never bound as worker: no task to annotate.
    const t = enqueue(h.db, wsA, { type: 'bug', title: 'Mine' });
    await byName(defs, 'approve_task').execute({ id: t.id }, execA);
    await assert.rejects(() => note.execute({ text: 'too early' }, execA), /no active task bound/);
    assert.equal(get(h.db, t.id).notes, '');
    store.workspaceRegistry.list = () => [
      { id: 'a', path: 'C:/repo-a', sessionIds: ['sess-a', 'sess-worker'] },
      { id: 'b', path: 'C:/repo-b', sessionIds: ['sess-b'] },
    ];
    const execW = { agent: { session: { header: { id: 'sess-worker' } } } };
    await byName(defs, 'get_my_task').execute({}, execW); // binds sess-worker
    const before = get(h.db, t.id);
    const first = await note.execute({ text: 'flagged: helper duplicated in lib/net.js' }, execW);
    assert.match(first.notes, /^- \[.+\] flagged: helper duplicated in lib\/net\.js$/);
    // A note touches no queue field and promotes nothing.
    assert.equal(first.state, before.state);
    assert.equal(first.branch, before.branch);
    assert.equal(first.worker_session, before.worker_session);
    assert.equal(first.queued_at, before.queued_at);
    assert.ok(first.updated_at >= before.updated_at);
    const [c1] = note.output.render({ text: 'x' }, first);
    assert.match(c1.text, /^noted #\d+ \[active\] Mine \(bug\) branch=\S+ \| notes: 1$/);
    const second = await note.execute({ text: 'blocker: gh unauthenticated' }, execW);
    const [c2] = note.output.render({ text: 'x' }, second);
    assert.match(c2.text, /\| notes: 2$/);
    const lines = second.notes.split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], first.notes, 'the earlier entry is never rewritten');
    assert.equal(get(h.db, t.id).state, 'active');
    assert.equal(get(h.db, t.id).notes, second.notes);
    // Empty whitespace is rejected by the domain rule, not the schema.
    await assert.rejects(() => note.execute({ text: '   ' }, execW), /non-empty/);
    // The note is visible to the model through the task_detail projection.
    const [d] = byName(defs, 'task_detail').output.render({ id: 1 }, get(h.db, t.id));
    assert.equal(JSON.parse(d.text).notes, second.notes);
    h.close();
  });

  it('finish_task promotion spawns the next worker (no limbo)', async () => {
    const { h, store, wsA } = mockStore();
    // Host-style hook: what lib/index.js injects as runtime.spawnHooks.
    const calls = [];
    // Test double binds the worker identity the test actually drives
    // (production spawnWorker binds the fresh session the same way).
    store.spawnHooks = {
      spawnForPromotion: async ({ db, workspace, promoted }) => {
        calls.push({ promoted, workspace });
        const { bindSession } = await import('../lib/queue.js');
        bindSession(db, promoted.id, 'sess-worker');
        return { sessionId: 'sess-worker' };
      },
    };
    const defs = makeToolDefinitions(store);
    store.workspaceRegistry.list = () => [
      { id: 'a', path: 'C:/repo-a', sessionIds: ['sess-a', 'sess-worker', 'sess-worker-2'] },
      { id: 'b', path: 'C:/repo-b', sessionIds: ['sess-b'] },
    ];
    const execW = { agent: { session: { header: { id: 'sess-worker' } } } };
    const one = enqueue(h.db, wsA, { type: 'bug', title: 'First' });
    const two = enqueue(h.db, wsA, { type: 'bug', title: 'Second' });
    await byName(defs, 'approve_task').execute({ id: one.id }, execA);
    await byName(defs, 'approve_task').execute({ id: two.id }, execA);
    assert.equal(calls.length, 1, 'approve of #1 spawns its worker');
    // Approve already bound sess-worker via the spawn (no lazy read needed);
    // the bound read just returns the owned task.
    const mine = await byName(defs, 'get_my_task').execute({}, execW);
    assert.equal(mine.id, one.id);
    const done = await byName(defs, 'finish_task').execute({ outcome: 'done' }, execW);
    assert.equal(done.task.state, 'done');
    assert.ok(done.promoted, 'second task promoted');
    assert.equal(done.promoted.id, two.id);
    assert.equal(calls.length, 2, 'finish spawns the promoted worker');
    assert.equal(calls[1].promoted.id, two.id);
    assert.deepEqual(done.spawn, { sessionId: 'sess-worker' });
    const [c] = byName(defs, 'finish_task').output.render({ outcome: 'done' }, done);
    assert.match(c.text, /worker sess-worker/);
    // The promoted task is bound: no limbo, a chat owns it.
    const { get } = await import('../lib/queue.js');
    assert.equal(get(h.db, two.id).worker_session, 'sess-worker');
    h.close();
  });

  it('without a spawn hook the queue stays pure (no spawn field)', async () => {
    const { h, store, wsA } = mockStore();
    const defs = makeToolDefinitions(store);
    store.workspaceRegistry.list = () => [
      { id: 'a', path: 'C:/repo-a', sessionIds: ['sess-a', 'sess-worker'] },
      { id: 'b', path: 'C:/repo-b', sessionIds: ['sess-b'] },
    ];
    const execW = { agent: { session: { header: { id: 'sess-worker' } } } };
    const one = enqueue(h.db, wsA, { type: 'bug', title: 'First' });
    const two = enqueue(h.db, wsA, { type: 'bug', title: 'Second' });
    await byName(defs, 'approve_task').execute({ id: one.id }, execA);
    await byName(defs, 'approve_task').execute({ id: two.id }, execA);
    await byName(defs, 'get_my_task').execute({}, execW);
    const done = await byName(defs, 'finish_task').execute({ outcome: 'done' }, execW);
    assert.equal(done.task.state, 'done');
    assert.ok(done.promoted, 'promotion still happens without a hook');
    assert.equal(done.spawn, undefined);
    h.close();
  });

  it('scoped worker entry (preset path) spawns on finish promotion', async () => {
    // The production worker resolves finish_task to the SCOPED registration
    // (preset mounts dsh-tasks-manager/worker-tools, not the host entry),
    // so the hook must live there too — otherwise the promoted task limbos.
    // The scoped runtime owns its DB file (config dshHome); the test opens
    // the SAME file directly to file fixtures, then drives the scoped defs.
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { applyScopedTools, WORKER_TOOLS } = await import('../lib/scoped.js');
    const { openDatabase } = await import('../lib/db.js');
    const { dbFilePath } = await import('../lib/paths.js');
    const { enqueue: qEnqueue, ensureWorkspace: qEnsure, approve: qApprove, bindSession: qBind, get: qGet } = await import('../lib/queue.js');
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-tasks-scoped-'));
    const registered = [];
    const disposers = [];
    const fakeCtx = {
      get: () => undefined, // no agents service: spawn fails closed with error
      effect: (fn) => { disposers.push(fn); return () => {}; },
      on: () => () => {},
      inject: (deps, cb) => {
        if (deps.includes('workspaceRegistry')) {
          cb({ get: () => ({ list: () => [{ id: 'a', path: 'C:/repo-a', sessionIds: ['sess-u', 'sess-w'] }] }) });
        }
        if (deps.includes('tools')) {
          cb({ tools: { register: (d) => { registered.push(d); return () => {}; } } });
        }
        if (deps.includes('settings')) {
          // Automatic mode for this test: workerCanFinish true.
          cb({ settings: { get: () => ({ workerCanFinish: true }) } });
        }
      },
    };
    try {
      applyScopedTools(fakeCtx, { enabled: true, dshHome }, WORKER_TOOLS);
      const byNameS = (n) => registered.find((d) => d.name === n);
      assert.ok(byNameS('finish_task'), 'worker subset mounts finish_task');
      assert.ok(byNameS('get_my_task'), 'worker subset mounts get_my_task');
      assert.ok(byNameS('note_task'), 'worker subset mounts note_task');
      assert.ok(!byNameS('approve_task'), 'no USER-ONLY tools in worker subset');
      // Fixtures through the same DB file the scoped runtime owns.
      const direct = openDatabase({ path: dbFilePath(dshHome) });
      const wsRow = qEnsure(direct.db, 'C:/repo-a');
      const one = qEnqueue(direct.db, wsRow, { type: 'bug', title: 'One' });
      const two = qEnqueue(direct.db, wsRow, { type: 'bug', title: 'Two' });
      qApprove(direct.db, one.id);
      qApprove(direct.db, two.id);
      qBind(direct.db, one.id, 'sess-w');
      direct.close();
      const execW = { agent: { session: { header: { id: 'sess-w' } } } };
      const done = await byNameS('finish_task').execute({ outcome: 'done' }, execW);
      assert.equal(done.task.state, 'done');
      assert.equal(done.promoted.id, two.id);
      // No agents in the fake ctx: promotion stands WITH the error, never limbo.
      assert.match(done.spawn.error, /agents service unavailable/);
      const verify = openDatabase({ path: dbFilePath(dshHome) });
      assert.equal(qGet(verify.db, two.id).state, 'active');
      verify.close();
    } finally {
      for (const fn of disposers) { try { const d = fn(); if (typeof d === 'function') d(); } catch {} }
      rmSync(dshHome, { recursive: true, force: true });
    }
  });

  it('scoped worker entry hides finish_task in manual mode (default)', async () => {
    const { applyScopedTools, WORKER_TOOLS } = await import('../lib/scoped.js');
    const registered = [];
    const fakeCtx = {
      get: () => undefined,
      effect: () => () => {},
      on: () => () => {},
      inject: (deps, cb) => {
        if (deps.includes('workspaceRegistry')) {
          cb({ get: () => ({ list: () => [] }) });
        }
        if (deps.includes('tools')) {
          cb({ tools: { register: (d) => { registered.push(d); return () => {}; } } });
        }
        if (deps.includes('settings')) {
          cb({ settings: { get: () => ({ workerCanFinish: false }) } });
        }
      },
    };
    applyScopedTools(fakeCtx, { enabled: true }, WORKER_TOOLS);
    const names = registered.map((d) => d.name).sort();
    // note_task is NOT gated by the finish switch: it changes no queue state,
    // so the worker keeps it in manual mode too.
    assert.deepEqual(names, ['get_my_task', 'list_tasks', 'note_task', 'task_detail']);
  });

  it('finish gate unit: mounts/unmounts on sync', async () => {
    const { createFinishGate, workerCanFinishOf, workerCanMergeOf, workerRulesOf } = await import('../lib/finish-toggle.js');
    assert.equal(workerCanFinishOf(undefined), false);
    assert.equal(workerCanFinishOf({}), false);
    assert.equal(workerCanFinishOf({ workerCanFinish: true }), true);
    assert.equal(workerCanMergeOf(undefined), false);
    assert.equal(workerCanMergeOf({}), false);
    assert.equal(workerCanMergeOf({ workerCanMerge: true }), true);
    assert.equal(workerCanMergeOf({ workerCanMerge: 'yes' }), false);
    assert.equal(workerRulesOf(undefined), '');
    assert.equal(workerRulesOf({}), '');
    assert.equal(workerRulesOf({ workerRules: 42 }), '');
    assert.equal(workerRulesOf({ workerRules: 'alla fine del lavoro aggiorna la wiki' }), 'alla fine del lavoro aggiorna la wiki');
    const mounted = [];
    let disposed = 0;
    const fakeDefs = [{ name: 'get_my_task' }, { name: 'finish_task' }];
    const listeners = [];
    const gate = createFinishGate({
      all: fakeDefs,
      register: (d) => { mounted.push(d.name); return () => { disposed += 1; }; },
      initiallyEnabled: false,
      onChange: (cb) => { listeners.push(cb); return () => {}; },
    });
    assert.deepEqual(mounted, ['get_my_task']);
    gate.sync(true);
    assert.deepEqual(mounted, ['get_my_task', 'finish_task']);
    gate.sync(true); // idempotent: no double mount
    assert.deepEqual(mounted, ['get_my_task', 'finish_task']);
    listeners[0](true); // event path
    assert.deepEqual(mounted, ['get_my_task', 'finish_task']);
    listeners[0](false);
    assert.equal(disposed, 1);
    gate.dispose();
  });

  it('a failed promotion spawn keeps the task active with the error attached', async () => {
    const { h, store, wsA } = mockStore();
    store.spawnHooks = {
      spawnForPromotion: async () => ({ error: 'no agents today' }),
    };
    const defs = makeToolDefinitions(store);
    store.workspaceRegistry.list = () => [
      { id: 'a', path: 'C:/repo-a', sessionIds: ['sess-a', 'sess-worker'] },
      { id: 'b', path: 'C:/repo-b', sessionIds: ['sess-b'] },
    ];
    const execW = { agent: { session: { header: { id: 'sess-worker' } } } };
    const one = enqueue(h.db, wsA, { type: 'bug', title: 'First' });
    const two = enqueue(h.db, wsA, { type: 'bug', title: 'Second' });
    await byName(defs, 'approve_task').execute({ id: one.id }, execA);
    await byName(defs, 'approve_task').execute({ id: two.id }, execA);
    await byName(defs, 'get_my_task').execute({}, execW);
    const done = await byName(defs, 'finish_task').execute({ outcome: 'done' }, execW);
    assert.equal(done.promoted.id, two.id);
    assert.deepEqual(done.spawn, { error: 'no agents today' });
    const { get } = await import('../lib/queue.js');
    assert.equal(get(h.db, two.id).state, 'active');
    const [c] = byName(defs, 'finish_task').output.render({ outcome: 'done' }, done);
    assert.match(c.text, /worker spawn failed: no agents today/);
    h.close();
  });

  it('search_tasks finds history before filing (dedup)', async () => {
    const { h, store, wsA } = mockStore();
    const defs = makeToolDefinitions(store);
    const s = byName(defs, 'search_tasks');
    enqueue(h.db, wsA, { type: 'bug', title: 'Login crash', spec: 'problem: crash on tap' });
    const hits = await s.execute({ query: 'login' }, execA);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, 'Login crash');
    const [c] = s.output.render({ query: 'login' }, hits);
    assert.match(c.text, /#\d+ \[draft\]/);
    const empty = await s.execute({ query: 'zzz' }, execA);
    assert.deepEqual(empty, []);
    assert.equal(s.output.render({ query: 'zzz' }, empty)[0].text, 'no matches');
    await assert.rejects(() => s.execute({ query: '' }, execA), /non-empty/);
    h.close();
  });
});

describe('queue ownership + clash (FIX-07/FIX-12)', () => {
  it('closed branches still clash: suffix -2 is issued (design S7/S13)', () => {
    // Branches are per-id, so a natural collision cannot happen between two
    // live tasks. The real hazard is a residual branch: a closed row keeps its
    // branch (never deleted on close, design S8) and ids can be reused after a
    // DB restore. Simulate it: a done row already holds the branch the next
    // promotion would generate -> the promoter must suffix -2.
    // (Fails on the pre-fix clash check, which only looked at active|queued.)
    const { h, wsA } = mockStore();
    const a = enqueue(h.db, wsA, { type: 'bug', title: 'Same name' });
    approve(h.db, a.id);
    close(h.db, a.id, 'done');
    const b = enqueue(h.db, wsA, { type: 'bug', title: 'Same name' });
    // Force the residual: pretend branch task/<b.seq>-same-name is taken by history.
    h.db.prepare("UPDATE tasks SET branch = ?, state = ? WHERE id = ?").run('task/' + b.seq + '-same-name', 'done', a.id);
    const r = approve(h.db, b.id);
    assert.ok(r.promoted.branch.endsWith('-2'), 'expected -2 suffix, got ' + r.promoted.branch);
    h.close();
  });
});
