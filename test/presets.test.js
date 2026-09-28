// Preset publication. Since DSH 0.1.7-rc.2 a preset is an
// `@deepseek-ai/dsh-agent-preset` DECLARATION carried by a bundle patch — the
// harness reads declarations and never scans `$DSH_HOME/.agent-presets/<id>/`
// (nothing reads that root any more), so these files ARE the shipped presets.
// The pins below keep the declarations, the package's own `dsh.bundle.patch`
// list and the plugin's runtime in step; `scripts/validate-presets.mjs`
// (`npm run check`) does the deep pass: it parses every patch with the
// loader's entry-list dialect and validates each row's config against the
// installed plugin's Config schema.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WORKER_PRESET } from '../lib/spawn.js';
import { CONFIG_KEYS, SETTINGS_KEYS } from '../lib/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** The `dsh.bundle.patch` list, normalized to an array. */
function patchList() {
  const patch = pkg.dsh.bundle.patch;
  return Array.isArray(patch) ? patch : [patch];
}

/** One shipped file, LF-normalized (a CRLF checkout must not skew a pin). */
function shipped(rel) {
  return readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
}

/** The preset declarations this package ships, as file names. */
function presetPatchFiles() {
  return readdirSync(join(root, 'presets')).filter((f) => f.endsWith('.patch.yml'));
}

const PRESETS = [
  { id: 'taskqueue-intake', name: 'Task Intake', order: 10 },
  { id: 'taskqueue-worker', name: 'Task Worker', order: 11 },
];

describe('preset declarations (bundle patches)', () => {
  it('the bundle patch list carries the plugin row first, then both presets', () => {
    assert.deepEqual(patchList(), [
      './cordis.patch.yml',
      './presets/taskqueue-intake.patch.yml',
      './presets/taskqueue-worker.patch.yml',
    ]);
  });

  it('every shipped preset patch is listed, and every listed file exists', () => {
    const listed = patchList().map((rel) => rel.replace('./presets/', ''));
    for (const file of presetPatchFiles()) {
      assert.ok(listed.includes(file), file + ' is shipped but not listed in dsh.bundle.patch');
    }
    for (const rel of patchList()) {
      assert.ok(existsSync(join(root, rel)), rel + ' is listed but missing');
    }
  });

  it('each declaration carries id, display metadata and a plugins list', () => {
    for (const { id, name, order } of PRESETS) {
      const text = shipped('presets/' + id + '.patch.yml');
      assert.match(text, new RegExp('^    - id: preset-' + id + '$', 'm'), id + ' row id');
      assert.match(text, /^      name: '@deepseek-ai\/dsh-agent-preset'$/m);
      assert.match(text, new RegExp('^        id: ' + id + '$', 'm'), id + ' config id');
      assert.match(text, new RegExp('^        name: ' + name + '$', 'm'), id + ' display name');
      assert.match(text, new RegExp('^        order: ' + order + '$', 'm'), id + ' roster order');
      assert.match(text, /^        plugins:$/m, id + ' mounts an entry list');
    }
  });

  it('the worker preset the spawner mounts is a shipped declaration', () => {
    // lib/spawn.js resolves and mounts WORKER_PRESET by id: the declaration's
    // config.id must be that exact string or every promotion fails to mount.
    assert.ok(PRESETS.some((p) => p.id === WORKER_PRESET), WORKER_PRESET + ' is not a shipped preset');
    assert.match(shipped('presets/' + WORKER_PRESET + '.patch.yml'), new RegExp('^        id: ' + WORKER_PRESET + '$', 'm'));
    assert.match(shipped('presets/' + WORKER_PRESET + '.patch.yml'), /name: 'dsh-tasks-manager\/worker-tools'/);
  });

  it('the intake preset mounts the read-only entry and never the fs suite', () => {
    // Write tools reach triage by mounting dsh-tool-fs (read+write+edit in one
    // suite) or str_replace_editor: the declaration must mount neither.
    const text = shipped('presets/taskqueue-intake.patch.yml');
    assert.match(text, /name: 'dsh-tasks-manager\/read-tool'/);
    assert.match(text, /name: 'dsh-tasks-manager\/intake-tools'/);
    assert.doesNotMatch(text, /name: '@deepseek-ai\/dsh-tool-fs'/);
    assert.doesNotMatch(text, /name: '[^']*str_replace_editor'/);
  });

  it('every dsh-tasks-manager/<entry> row resolves to a shipped export', () => {
    // A preset mounts the plugin's scoped entries by subpath; a renamed or
    // dropped export is a mount failure, so bind every row to package.json.
    for (const { id } of PRESETS) {
      const text = shipped('presets/' + id + '.patch.yml');
      const names = [...text.matchAll(/name: 'dsh-tasks-manager\/([^']+)'/g)].map((m) => m[1]);
      assert.ok(names.length > 0, id + ' mounts no scoped entry');
      for (const name of names) {
        const rel = pkg.exports['./' + name];
        assert.equal(typeof rel, 'string', 'no export for dsh-tasks-manager/' + name);
        assert.ok(existsSync(join(root, rel)), 'missing file for dsh-tasks-manager/' + name + ': ' + rel);
      }
    }
  });

  it('the legacy on-disk mechanism is gone', () => {
    // The old shape (a directory + preset.yml + agent.cordis.yml copied into
    // <dshHome>/.agent-presets at boot) is dead: no DSH build reads it.
    for (const { id } of PRESETS) {
      assert.equal(existsSync(join(root, 'presets', id)), false, id + ' legacy directory');
    }
    assert.equal(existsSync(join(root, 'lib', 'presets-sync.js')), false, 'presets-sync.js');
    assert.equal(CONFIG_KEYS.includes('syncPresets'), false, 'syncPresets config key');
    // The live settings namespace is untouched by the migration.
    assert.deepEqual([...SETTINGS_KEYS].sort(), ['baseBranch', 'workerCanFinish', 'workerCanMerge', 'workerModel', 'workerRules']);
  });

  it('worker preset pins the auto-merge liturgy (--no-ff, abort on conflict)', () => {
    // Content pin: future preset edits must not silently drop the merge
    // rule or the conflict discipline. Reads the SHIPPED declaration.
    const text = shipped('presets/taskqueue-worker.patch.yml');
    assert.match(text, /## Auto-merge/);
    assert.match(text, /git merge --no-ff <branch>/);
    assert.match(text, /git merge --abort/);
    assert.match(text, /FORBIDDEN to unblock yourself/);
    assert.match(text, /--theirs\/--ours/);
    assert.match(text, /The task stays open/);
    // The default-off rule survives alongside: manual mode never touches base.
    assert.match(text, /when auto-merge is OFF/);
    assert.match(text, /merged: <SHA>/);
    // The spawn message (not memory) is authoritative for the modes.
    assert.match(text, /that line\s+is authoritative, NOT your memory/);
  });
});
