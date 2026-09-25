import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Config, CONFIG_KEYS, resolveConfig, tasksSchema } from '../lib/config.js';

describe('config guard', () => {
  it('accepts the documented explicit config (FIX-01)', () => {
    const r = resolveConfig({ enabled: true, order: 50, allowCommand: true, baseBranch: '' });
    assert.equal(r.enabled, true);
    assert.equal(r.order, 50);
    assert.equal(r.allowCommand, true);
    assert.equal(r.baseBranch, '');
  });

  it('still rejects unknown keys', () => {
    assert.throws(() => resolveConfig({ enabled: true, nope: 1 }), /unknown key nope/);
  });

  it('CONFIG_KEYS match the documented keys exactly', () => {
    assert.deepEqual([...CONFIG_KEYS].sort(), [
      'allowCommand', 'baseBranch', 'dshHome', 'enabled', 'order', 'section', 'syncPresets',
      'updateIncludePrerelease', 'updateProfile', 'updateProfileDir', 'updateRepository', 'updateTimeoutMs', 'updateToken',
    ]);
  });

  it('fills schemastery defaults for missing keys', () => {
    const r = resolveConfig({});
    assert.equal(r.enabled, false);
    assert.equal(r.order, 50);
    assert.equal(r.allowCommand, true);
    assert.equal(typeof r.section, 'string');
  });

  it('rejects wrong types at compose time (schemastery)', () => {
    assert.throws(() => resolveConfig({ enabled: 'yes' }), /enabled/);
    assert.throws(() => resolveConfig({ order: 'fifty' }), /order/);
  });

  it('rejects empty section', () => {
    assert.throws(() => resolveConfig({ section: '  ' }), /non-empty/);
  });

  it('Config exposes Standard Schema validation for the Cordis loader', () => {
    assert.equal(typeof Config['~standard'].validate, 'function');
    const ok = Config['~standard'].validate({ enabled: true });
    assert.equal(ok.value.enabled, true);
  });

  it('carries the six updater keys with their deployment defaults', () => {
    const r = resolveConfig({});
    assert.equal(r.updateRepository, 'necos98/dsh-tasks-manager');
    assert.equal(r.updateProfile, '');
    assert.equal(r.updateIncludePrerelease, false);
    assert.equal(r.updateTimeoutMs, 180000);
    assert.equal(r.updateProfileDir, '');
    assert.equal(r.updateToken, '');
  });

  it('accepts explicit updater values and validates their types', () => {
    const r = resolveConfig({
      updateRepository: 'necos98/dsh-tasks-manager',
      updateProfile: 'web',
      updateIncludePrerelease: true,
      updateTimeoutMs: 5000,
      updateProfileDir: 'C:/Users/jacob/.dsh/profiles/web',
      updateToken: 'ghp_x',
    });
    assert.equal(r.updateProfile, 'web');
    assert.equal(r.updateIncludePrerelease, true);
    assert.equal(r.updateTimeoutMs, 5000);
    assert.equal(r.updateProfileDir, 'C:/Users/jacob/.dsh/profiles/web');
    assert.equal(r.updateToken, 'ghp_x');
    assert.throws(() => resolveConfig({ updateIncludePrerelease: 'yes' }), /updateIncludePrerelease/);
    assert.throws(() => resolveConfig({ updateTimeoutMs: 'soon' }), /updateTimeoutMs/);
  });
});

describe('tasksSchema (settings)', () => {
  it('resolves defaults like every official caller expects', () => {
    assert.deepEqual(tasksSchema({}), { baseBranch: '', workerCanFinish: false, workerCanMerge: false, workerRules: '', workerModel: '' });
    assert.deepEqual(tasksSchema({ baseBranch: 'main' }), { baseBranch: 'main', workerCanFinish: false, workerCanMerge: false, workerRules: '', workerModel: '' });
  });

  it('rejects non-string baseBranch', () => {
    assert.throws(() => tasksSchema({ baseBranch: 42 }), /baseBranch/);
  });

  it('workerCanFinish defaults false and validates booleans', () => {
    assert.deepEqual(tasksSchema({ workerCanFinish: true }), { baseBranch: '', workerCanFinish: true, workerCanMerge: false, workerRules: '', workerModel: '' });
    assert.throws(() => tasksSchema({ workerCanFinish: 'yes' }), /workerCanFinish/);
  });

  it('workerCanMerge defaults false and validates booleans', () => {
    assert.deepEqual(tasksSchema({ workerCanMerge: true }), { baseBranch: '', workerCanFinish: false, workerCanMerge: true, workerRules: '', workerModel: '' });
    assert.throws(() => tasksSchema({ workerCanMerge: 'yes' }), /workerCanMerge/);
  });

  it('workerRules defaults to empty string and stays verbatim', () => {
    assert.deepEqual(tasksSchema({ workerRules: 'alla fine del lavoro aggiorna la wiki' }), {
      baseBranch: '', workerCanFinish: false, workerCanMerge: false,
      workerRules: 'alla fine del lavoro aggiorna la wiki', workerModel: '',
    });
    assert.throws(() => tasksSchema({ workerRules: 42 }), /workerRules/);
  });

  it('workerModel defaults to empty string and validates strings', () => {
    assert.deepEqual(tasksSchema({ workerModel: 'anthropic/claude-3.5-sonnet' }), {
      baseBranch: '', workerCanFinish: false, workerCanMerge: false,
      workerRules: '', workerModel: 'anthropic/claude-3.5-sonnet',
    });
    assert.throws(() => tasksSchema({ workerModel: 42 }), /workerModel/);
  });
});
