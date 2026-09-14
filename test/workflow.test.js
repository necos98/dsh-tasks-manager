// Workflow integration: the REAL plugin on a REAL minimal host.
// Boot is real (Cordis Context + SystemPrompt/ToolRuntime/CommandRuntime/
// SettingsProvider); dispatch crosses tools.register validation, defineTool
// arg checks, output-schema validation and render; SQLite lives on disk in a
// fresh tmp dshHome per suite. Only seams stubbed: workspaceRegistry +
// settings file backend. No model, no presets: this is Level-1 integration.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootHost } from './support/host.js';
import { callTool, runCommand, toolNames } from './support/calls.js';

describe('workflow on the real host', () => {
  let host;
  before(async () => { host = await bootHost(); });
  after(async () => { await host.dispose(); });

  it('manual mode hides finish_task by default (workerCanFinish:false)', () => {
    assert.deepEqual(toolNames(host.ctx), [
      'approve_task', 'close_task', 'edit_draft', 'enqueue_task', 'get_my_task', 'list_tasks', 'note_task', 'search_tasks', 'task_detail',
    ]);
  });

  it('flipping workerCanFinish mounts/unmounts finish_task live', async () => {
    // Production path: an external settings edit re-resolves + emits
    // settings/updated, and the gate resyncs (publish = provider push).
    const settings = host.ctx.get('settings');
    settings.publish({ tasks: { workerCanFinish: true } });
    assert.deepEqual(toolNames(host.ctx), [
      'approve_task', 'close_task', 'edit_draft', 'enqueue_task', 'finish_task', 'get_my_task', 'list_tasks', 'note_task', 'search_tasks', 'task_detail',
    ]);
    settings.publish({ tasks: { workerCanFinish: false } });
    assert.deepEqual(toolNames(host.ctx), [
      'approve_task', 'close_task', 'edit_draft', 'enqueue_task', 'get_my_task', 'list_tasks', 'note_task', 'search_tasks', 'task_detail',
    ]);
  });

  it('resolves the tasks settings namespace with defaults (FIX-05/06)', () => {
    assert.deepEqual(host.ctx.get('settings').get('tasks'), { baseBranch: '', workerCanFinish: false, workerCanMerge: false, workerRules: '', workerModel: '' });
  });

  it('/tasks returns a CommandResult (FIX-04 acceptance)', async () => {
    const settled = await runCommand(host.ctx, 'sess-a', '/tasks');
    assert.equal(settled.result.kind, 'success');
    assert.match(settled.result.text, /Tasks panel/);
  });

  it('triage amends a draft via edit_draft; approve still promotes it', async () => {
    const filed = await callTool(host.ctx, 'sess-a', 'enqueue_task', {
      type: 'bug', title: 'Login mobile', spec: 'problem: crash',
    });
    const edited = await callTool(host.ctx, 'sess-a', 'edit_draft', {
      id: filed.value.id, title: 'Login desktop', spec: 'problem: crash; acceptance: no crash',
    });
    assert.equal(edited.value.title, 'Login desktop');
    assert.equal(edited.value.slug, 'login-desktop');
    assert.match(edited.content[0].text, /^edited #\d+ \[draft\]/);
    const approved = await callTool(host.ctx, 'sess-a', 'approve_task', { id: filed.value.id });
    assert.equal(approved.value.task.state, 'active');
    assert.match(approved.content[0].text, /task\/\d+-login-desktop/);
    // Leave the shared host as found: close the task so the slot is free
    // for the tests below.
    await callTool(host.ctx, 'sess-a', 'close_task', { id: filed.value.id, outcome: 'done' });
  });

  it('triage files a draft; approve promotes it to active', async () => {
    const filed = await callTool(host.ctx, 'sess-a', 'enqueue_task', {
      type: 'bug', title: 'Login mobile', spec: 'problema: crash; acceptance: no crash',
    });
    assert.equal(filed.value.state, 'draft');
    assert.match(filed.content[0].text, /^draft #\d+ \[draft\]/);

    const approved = await callTool(host.ctx, 'sess-a', 'approve_task', { id: filed.value.id });
    assert.equal(approved.value.task.state, 'active');
    assert.ok(approved.value.promoted);
    assert.match(approved.content[0].text, /task\/\d+-login-mobile/);
  });

  it('worker first read binds the session; second session stays unbound', async () => {
    // sess-a approved above but must NOT own the task (approver is the user).
    const workerCtx = await bootHost({
      workspaces: [{ id: 'a', path: 'C:/repo-a', sessionIds: ['sess-user', 'sess-worker'] }],
    });
    try {
      const filed = await callTool(workerCtx.ctx, 'sess-user', 'enqueue_task', { type: 'feature', title: 'Bind me' });
      await callTool(workerCtx.ctx, 'sess-user', 'approve_task', { id: filed.value.id });
      const mine = await callTool(workerCtx.ctx, 'sess-worker', 'get_my_task', {});
      assert.equal(mine.value.id, filed.value.id);
      assert.equal(mine.value.worker_session, 'sess-worker');
    } finally {
      await workerCtx.dispose();
    }
  });

  it('cross-workspace approve mutates nothing (FIX-07 acceptance)', async () => {
    const filed = await callTool(host.ctx, 'sess-a', 'enqueue_task', { type: 'chore', title: 'Other ws' });
    await assert.rejects(
      () => callTool(host.ctx, 'sess-b', 'approve_task', { id: filed.value.id }),
      /no task #\d+ here/,
    );
    const detail = await callTool(host.ctx, 'sess-a', 'task_detail', { id: filed.value.id });
    assert.equal(detail.value.state, 'draft');
  });

  it('both workspaces number their first task #1 (per-workspace sequence)', async () => {
    const iso = await bootHost();
    try {
      const a = await callTool(iso.ctx, 'sess-a', 'enqueue_task', { type: 'bug', title: 'First in A' });
      const b = await callTool(iso.ctx, 'sess-b', 'enqueue_task', { type: 'bug', title: 'First in B' });
      const c = await callTool(iso.ctx, 'sess-a', 'enqueue_task', { type: 'bug', title: 'Second in A' });
      assert.equal(a.value.seq, 1);
      assert.equal(b.value.seq, 1);
      assert.equal(c.value.seq, 2);
      assert.match(a.content[0].text, /^draft #1 \[draft\]/);
      assert.match(b.content[0].text, /^draft #1 \[draft\]/);
      assert.match(c.content[0].text, /^draft #2 \[draft\]/);
      // Approve by visible seq through the real pipeline; branches use seq too.
      const approved = await callTool(iso.ctx, 'sess-a', 'approve_task', { id: 2 });
      assert.equal(approved.value.task.id, c.value.id);
      assert.equal(approved.value.task.branch, 'task/2-second-in-a');
    } finally {
      await iso.dispose();
    }
  });

  it('close frees the slot and FIFO advances the queue', async () => {
    // Isolated host: earlier tests already occupy the shared slot.
    const fifo = await bootHost();
    try {
      const a = await callTool(fifo.ctx, 'sess-a', 'enqueue_task', { type: 'bug', title: 'Fifo one' });
      const b = await callTool(fifo.ctx, 'sess-a', 'enqueue_task', { type: 'bug', title: 'Fifo two' });
      await callTool(fifo.ctx, 'sess-a', 'approve_task', { id: a.value.id });
      const rb = await callTool(fifo.ctx, 'sess-a', 'approve_task', { id: b.value.id });
      assert.equal(rb.value.task.state, 'queued');
      const closed = await callTool(fifo.ctx, 'sess-a', 'close_task', { id: a.value.id, outcome: 'done' });
      assert.equal(closed.value.task.state, 'done');
      assert.equal(closed.value.promoted.id, b.value.id);
      const detail = await callTool(fifo.ctx, 'sess-a', 'task_detail', { id: b.value.id });
      assert.equal(detail.value.state, 'active');
    } finally {
      await fifo.dispose();
    }
  });

  it('worker notes survive the whole cycle: enqueue -> approve -> note -> close', async () => {
    // Real pipeline: tools.get visibility, defineTool arg checks,
    // createSuccessResult output-schema validation (TASK_SCHEMA now carries
    // notes) and render. Manual mode: the worker may still annotate.
    const rt = await bootHost({
      workspaces: [{ id: 'a', path: 'C:/repo-a', sessionIds: ['sess-user', 'sess-worker'] }],
    });
    try {
      const filed = await callTool(rt.ctx, 'sess-user', 'enqueue_task', { type: 'bug', title: 'Annotated' });
      assert.equal(filed.value.notes, '');
      await callTool(rt.ctx, 'sess-user', 'approve_task', { id: filed.value.id });
      await callTool(rt.ctx, 'sess-worker', 'get_my_task', {}); // binds
      const noted = await callTool(rt.ctx, 'sess-worker', 'note_task', { text: 'flagged: no id parameter for note_task' });
      assert.match(noted.value.notes, /^- \[.+\] flagged: no id parameter for note_task$/);
      assert.equal(noted.value.state, 'active');
      assert.match(noted.content[0].text, /\| notes: 1$/);
      const detail = await callTool(rt.ctx, 'sess-user', 'task_detail', { id: filed.value.id });
      assert.equal(JSON.parse(detail.content[0].text).notes, noted.value.notes);
      // A note never moves the queue: the same task is still the active one.
      const listed = await callTool(rt.ctx, 'sess-user', 'list_tasks', { state: 'active' });
      assert.equal(listed.value.length, 1);
      assert.equal(listed.value[0].id, filed.value.id);
      const closed = await callTool(rt.ctx, 'sess-user', 'close_task', { id: filed.value.id, outcome: 'done' });
      assert.equal(closed.value.task.state, 'done');
      assert.equal(closed.value.task.notes, noted.value.notes, 'the log survives the close');
      // Closed rows are read-only for the worker: no note lands afterwards.
      await assert.rejects(
        () => callTool(rt.ctx, 'sess-worker', 'note_task', { text: 'too late' }),
        /no active task bound/,
      );
    } finally {
      await rt.dispose();
    }
  });

  it('manual mode: finish_task is not visible on the real host', async () => {
    const rt = await bootHost({
      workspaces: [{ id: 'a', path: 'C:/repo-a', sessionIds: ['sess-user', 'sess-worker'] }],
    });
    try {
      await assert.rejects(
        () => callTool(rt.ctx, 'sess-worker', 'finish_task', { outcome: 'done' }),
        /not visible/,
      );
    } finally {
      await rt.dispose();
    }
  });

  it('worker finish on the real host promotes and spawns (no limbo)', async () => {
    // The reported bug: task 2 goes active on finish_task but no chat opens.
    // On the real host the spawn fails closed (no agents service), so the
    // promotion stands WITH the error attached — never a silent limbo.
    // Needs workerCanFinish:true (default is manual).
    const rt = await bootHost({
      workspaces: [{ id: 'a', path: 'C:/repo-a', sessionIds: ['sess-user', 'sess-worker'] }],
    });
    try {
      rt.ctx.get('settings').publish({ tasks: { workerCanFinish: true } });
      const a = await callTool(rt.ctx, 'sess-user', 'enqueue_task', { type: 'bug', title: 'Rt one' });
      const b = await callTool(rt.ctx, 'sess-user', 'enqueue_task', { type: 'bug', title: 'Rt two' });
      await callTool(rt.ctx, 'sess-user', 'approve_task', { id: a.value.id });
      await callTool(rt.ctx, 'sess-user', 'approve_task', { id: b.value.id });
      await callTool(rt.ctx, 'sess-worker', 'get_my_task', {});
      const done = await callTool(rt.ctx, 'sess-worker', 'finish_task', { outcome: 'done' });
      assert.equal(done.value.task.state, 'done');
      assert.equal(done.value.promoted.id, b.value.id);
      assert.match(done.value.spawn.error, /agents service unavailable/);
      assert.match(done.content[0].text, /worker spawn failed/);
      const detail = await callTool(rt.ctx, 'sess-user', 'task_detail', { id: b.value.id });
      assert.equal(detail.value.state, 'active');
    } finally {
      await rt.dispose();
    }
  });

  it('invalid args fail through the real defineTool validation', async () => {
    await assert.rejects(
      () => callTool(host.ctx, 'sess-a', 'enqueue_task', { type: 'nope', title: 'X' }),
      /must be one of/,
    );
  });

  it('web RPC channel is registered with loopback authority', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Context } = await import('@deepseek-ai/cordis');
    const ToolRuntime = (await import('@deepseek-ai/dsh-tools')).default;
    const { CommandRuntime } = await import('@deepseek-ai/dsh-commands');
    const SystemPrompt = (await import('@deepseek-ai/dsh-system-prompt')).default;
    const plugin = await import('../lib/index.js');
    const { FakeRegistry } = await import('./support/fake-registry.js');
    const { MemorySettings } = await import('./support/memory-settings.js');

    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-tasks-rpc-'));
    const ctx = new Context();
    let captured = null;
    const fakeConnection = {
      rpc: {
        handle: (channel, handler, options) => {
          captured = { channel, handler, options };
        },
      },
    };
    // Minimal connection service double carrying the RPC face.
    const { Service } = await import('@deepseek-ai/cordis');
    class FakeConnection extends Service {
      static inject = [];
      constructor(c, config) {
        super(c, 'connection');
        this.rpc = fakeConnection.rpc;
      }
    }
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(class extends ToolRuntime {}, {});
    await ctx.plugin(CommandRuntime, {});
    await ctx.plugin(MemorySettings, {});
    await ctx.plugin(FakeRegistry, {});
    await ctx.plugin(FakeConnection, {});
    await ctx.plugin(plugin, {
      enabled: true, order: 50, allowCommand: true, baseBranch: '', dshHome,
    });
    try {
      assert.ok(captured, 'rpc.handle was called');
      assert.equal(captured.channel, '/tasks-queue');
      assert.deepEqual(captured.options, { authority: 'loopback' });
      // End-to-end through the captured channel: file via tool, read via RPC.
      // Minimal host here (no agents service): approve promotes to active,
      // the spawn fails closed, and the failure rides the payload WITHOUT
      // rolling back the promotion (failure policy, lib/web.js).
      const filed = await callTool(ctx, 'sess-a', 'enqueue_task', { type: 'bug', title: 'Via channel' });
      const snap = await captured.handler('snapshot', { sessionId: 'sess-a' });
      assert.equal(snap.ok, true);
      assert.equal(snap.value.tasks.length, 1);
      const approved = await captured.handler('approve', { sessionId: 'sess-a', id: filed.value.id });
      assert.equal(approved.ok, true);
      assert.equal(approved.value.task.state, 'active');
      assert.match(approved.value.spawn.error, /agents service unavailable/);
      const closed = await captured.handler('close', { sessionId: 'sess-a', id: filed.value.id, outcome: 'done' });
      assert.equal(closed.ok, true);
      assert.equal(closed.value.task.state, 'done');
    } finally {
      await ctx.fiber.dispose();
      rmSync(dshHome, { recursive: true, force: true });
    }
  });
});
