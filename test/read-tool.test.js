// The intake preset's read-only `read` tool, exercised through the real host
// pipeline (tools.get + defineTool execute + createSuccessResult) over a fake
// `fs` service. The point of the row is what it does NOT register: giving the
// triage agent a way to read files must never hand it write or edit.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootHost } from './support/host.js';
import { callTool, toolNames } from './support/calls.js';
import { FakeFs } from './support/fake-fs.js';
import * as readTool from '../lib/read-tool.js';

async function boot(files) {
  const host = await bootHost();
  await host.ctx.plugin(FakeFs, { files });
  await host.ctx.plugin(readTool, {});
  return host;
}

describe('read-tool (intake, read-only)', () => {
  it('registers `read` and no mutating tool', async () => {
    const host = await boot({ 'a.txt': { text: 'hello\n' } });
    try {
      const names = toolNames(host.ctx);
      assert.ok(names.includes('read'), 'read is mounted');
      assert.ok(!names.includes('write'), 'no write tool');
      assert.ok(!names.includes('edit'), 'no edit tool');
    } finally {
      await host.dispose();
    }
  });

  it('exposes the canonical read parameters (file_path required, offset/limit optional)', async () => {
    const host = await boot({});
    try {
      const definition = host.ctx.get('tools').get('read', undefined);
      assert.deepEqual(definition.parameters.required, ['file_path']);
      assert.deepEqual(Object.keys(definition.parameters.properties).sort(), ['file_path', 'limit', 'offset']);
    } finally {
      await host.dispose();
    }
  });

  it('reads a file with line numbers and the end-of-file footer', async () => {
    const host = await boot({ 'src/a.js': { text: 'const a = 1\nconst b = 2\n' } });
    try {
      const { value, content } = await callTool(host.ctx, 'sess-a', 'read', { file_path: 'src/a.js' });
      assert.equal(value, '<path>src/a.js</path>\n<type>file</type>\n<content>\n1: const a = 1\n2: const b = 2\n\n(End of file - total 2 lines)\n</content>');
      assert.equal(content[0].text, value);
    } finally {
      await host.dispose();
    }
  });

  it('honours offset and limit with a continuation footer', async () => {
    const host = await boot({ 'a.txt': { text: 'a\nb\nc\nd\n' } });
    try {
      const { value } = await callTool(host.ctx, 'sess-a', 'read', { file_path: 'a.txt', offset: 2, limit: 1 });
      assert.match(value, /^<path>a\.txt<\/path>/);
      assert.match(value, /2: b/);
      assert.match(value, /\(Showing lines 2-2 of 4\. Use offset=3 to continue\.\)/);
    } finally {
      await host.dispose();
    }
  });

  it('reports a missing file, a non-regular target and an out-of-range offset', async () => {
    const host = await boot({ 'dir': { dir: true }, 'a.txt': { text: 'a\n' } });
    try {
      await assert.rejects(
        () => callTool(host.ctx, 'sess-a', 'read', { file_path: 'nope.txt' }),
        /cannot read "nope\.txt": not found/,
      );
      await assert.rejects(
        () => callTool(host.ctx, 'sess-a', 'read', { file_path: 'dir' }),
        /not a regular file/,
      );
      await assert.rejects(
        () => callTool(host.ctx, 'sess-a', 'read', { file_path: 'a.txt', offset: 9 }),
        /out of range/,
      );
    } finally {
      await host.dispose();
    }
  });

  it('rejects invalid arguments through the parameter schema', async () => {
    const host = await boot({ 'a.txt': { text: 'a\n' } });
    try {
      await assert.rejects(() => callTool(host.ctx, 'sess-a', 'read', {}), /file_path/);
    } finally {
      await host.dispose();
    }
  });
});
