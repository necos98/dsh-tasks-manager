// Preset sync: at startup the plugin copies its own presets/taskqueue-*
// compositions into the user root, always overwriting the installed copy.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pluginPresetsRoot, PRESET_IDS, syncPluginPresets, USER_PRESET_DIR, userPresetRoot } from '../lib/presets-sync.js';
import { CONFIG_KEYS, resolveConfig } from '../lib/config.js';
import { bootHost } from './support/host.js';

function tmpRoot() { return mkdtempSync(join(tmpdir(), 'dsh-presets-sync-')); }

function makeSource(root) {
  for (const id of PRESET_IDS) {
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, 'agent.cordis.yml'), '- id: x\n  name: pkg\n');
    writeFileSync(join(root, id, 'preset.yml'), 'name: ' + id + '\n');
  }
  return root;
}

describe('presets-sync', () => {
  it('creates both presets on first sync', () => {
    const base = tmpRoot();
    try {
      const sourceRoot = makeSource(join(base, 'src'));
      const userRoot = join(base, 'home', USER_PRESET_DIR);
      const outcomes = syncPluginPresets({ sourceRoot, userRoot });
      assert.deepEqual(outcomes.map((o) => o.status), ['created', 'created']);
      for (const id of PRESET_IDS) {
        assert.equal(readFileSync(join(userRoot, id, 'agent.cordis.yml'), 'utf8'), '- id: x\n  name: pkg\n');
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('second sync overwrites again (updated)', () => {
    const base = tmpRoot();
    try {
      const sourceRoot = makeSource(join(base, 'src'));
      const userRoot = join(base, 'home', USER_PRESET_DIR);
      syncPluginPresets({ sourceRoot, userRoot });
      const again = syncPluginPresets({ sourceRoot, userRoot });
      assert.deepEqual(again.map((o) => o.status), ['updated', 'updated']);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('discards user edits in the installed copy', () => {
    const base = tmpRoot();
    try {
      const sourceRoot = makeSource(join(base, 'src'));
      const userRoot = join(base, 'home', USER_PRESET_DIR);
      syncPluginPresets({ sourceRoot, userRoot });
      writeFileSync(join(userRoot, 'taskqueue-intake', 'agent.cordis.yml'), '- id: mine\n');
      const outcomes = syncPluginPresets({ sourceRoot, userRoot });
      const intake = outcomes.find((o) => o.id === 'taskqueue-intake');
      assert.equal(intake.status, 'updated');
      assert.equal(readFileSync(join(userRoot, 'taskqueue-intake', 'agent.cordis.yml'), 'utf8'), '- id: x\n  name: pkg\n');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('replaces a hand-made directory with the plugin source', () => {
    const base = tmpRoot();
    try {
      const sourceRoot = makeSource(join(base, 'src'));
      const userRoot = join(base, 'home', USER_PRESET_DIR);
      mkdirSync(join(userRoot, 'taskqueue-intake'), { recursive: true });
      writeFileSync(join(userRoot, 'taskqueue-intake', 'agent.cordis.yml'), '- id: hand\n');
      const outcomes = syncPluginPresets({ sourceRoot, userRoot });
      const intake = outcomes.find((o) => o.id === 'taskqueue-intake');
      const worker = outcomes.find((o) => o.id === 'taskqueue-worker');
      assert.equal(intake.status, 'updated');
      assert.equal(worker.status, 'created');
      assert.equal(readFileSync(join(userRoot, 'taskqueue-intake', 'agent.cordis.yml'), 'utf8'), '- id: x\n  name: pkg\n');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('a missing source row reports failed without breaking the other row', () => {
    const base = tmpRoot();
    try {
      const sourceRoot = makeSource(join(base, 'src'));
      rmSync(join(sourceRoot, 'taskqueue-worker'), { recursive: true, force: true });
      const userRoot = join(base, 'home', USER_PRESET_DIR);
      const outcomes = syncPluginPresets({ sourceRoot, userRoot });
      const intake = outcomes.find((o) => o.id === 'taskqueue-intake');
      const worker = outcomes.find((o) => o.id === 'taskqueue-worker');
      assert.equal(intake.status, 'created');
      assert.equal(worker.status, 'failed');
      assert.match(worker.error, /ENOENT|no such file/i);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('syncPresets config flag defaults true and validates booleans', () => {
    assert.ok(CONFIG_KEYS.includes('syncPresets'));
    assert.equal(resolveConfig({}).syncPresets, true);
    assert.equal(resolveConfig({ syncPresets: false }).syncPresets, false);
    assert.throws(() => resolveConfig({ syncPresets: 'yes' }), /syncPresets/);
  });

  it('real boot syncs the real shipped presets into dshHome', async () => {
    const host = await bootHost();
    try {
      for (const id of PRESET_IDS) {
        assert.equal(readFileSync(join(host.dshHome, USER_PRESET_DIR, id, 'agent.cordis.yml'), 'utf8'), readFileSync(join(pluginPresetsRoot(), id, 'agent.cordis.yml'), 'utf8'));
      }
    } finally {
      await host.dispose();
    }
  });

  it('syncPresets:false boot leaves the user root alone', async () => {
    const host = await bootHost({ config: { syncPresets: false } });
    try {
      assert.deepEqual(host.ctx.get('settings').get('tasks'), { baseBranch: '' });
      let entries = [];
      try {
        entries = readdirSync(join(host.dshHome, USER_PRESET_DIR));
      } catch { entries = []; }
      assert.deepEqual(entries, []);
    } finally {
      await host.dispose();
    }
  });

  it('userPresetRoot joins the harness-home user preset dir', () => {
    assert.equal(userPresetRoot('/h'), join('/h', '.agent-presets'));
  });
});
