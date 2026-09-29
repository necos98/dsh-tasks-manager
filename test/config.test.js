import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  Config,
  CONFIG_KEYS,
  SETTINGS_KEYS,
  SETTINGS_NS,
  resolveConfig,
  settingsValueOf,
  toPlain,
} from '../lib/config.js';

/** Unwrap a resolved Config section the way DSH's plainConfig does. */
function plain(value) {
  return toPlain(value);
}

/** The settings-namespace subset of a resolved Config section. */
function settingsOf(resolved) {
  const all = plain(resolved);
  return Object.fromEntries(SETTINGS_KEYS.map((key) => [key, all[key]]));
}

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
      'allowCommand', 'baseBranch', 'commitLanguage', 'dshHome', 'enabled', 'messageStyle', 'order', 'section',
      'updateIncludePrerelease', 'updateProfile', 'updateProfileDir', 'updateRepository', 'updateTimeoutMs', 'updateToken',
      'workerCanFinish', 'workerGitMode', 'workerModel',
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

// The live settings namespace is now the VOLATILE subset of the plugin Config
// (DSH 0.1.7-rc.2 derives it from the entry's schema and keys it by the patch
// row id); the former standalone `tasksSchema` is gone.
describe('settings namespace (volatile Config fields)', () => {
  const NS = SETTINGS_NS;

  it('every settings field is volatile, so the namespace exists', () => {
    // describe() drops an entry whose volatileForm() is undefined: a schema with
    // NO volatile field produces no settings namespace at all, and the browser
    // half then can never see the settings.
    for (const key of SETTINGS_KEYS) {
      assert.equal(Config.dict[key]?.meta?.volatile, true, `${key} is volatile`);
    }
  });

  it('deployment-only keys stay OUT of the settings form', () => {
    // `section` is the policy text and `updateToken` is a secret: neither may
    // ride the settings form to the browser.
    for (const key of ['section', 'updateToken', 'enabled', 'order', 'allowCommand', 'dshHome']) {
      assert.notEqual(Config.dict[key]?.meta?.volatile, true, `${key} is not volatile`);
    }
  });

  it('SETTINGS_KEYS lists exactly the volatile fields', () => {
    const volatile = Object.keys(Config.dict).filter((k) => Config.dict[k].meta?.volatile === true);
    assert.deepEqual([...SETTINGS_KEYS].sort(), [...volatile].sort());
  });

  it('resolves defaults like every consumer expects', () => {
    assert.deepEqual(plain(Config({})), {
      enabled: false, order: 50, allowCommand: true, section: Config.dict.section.meta.default,
      dshHome: '', updateRepository: 'necos98/dsh-tasks-manager',
      updateProfile: '', updateIncludePrerelease: false, updateTimeoutMs: 180000,
      updateProfileDir: '', updateToken: '',
      baseBranch: '', workerCanFinish: false, workerGitMode: 'branch-automerge', commitLanguage: 'English', messageStyle: 'extended', workerModel: '',
    });
    assert.deepEqual(settingsOf(Config({ baseBranch: 'main' })), {
      baseBranch: 'main', workerCanFinish: false, workerGitMode: 'branch-automerge', commitLanguage: 'English', messageStyle: 'extended', workerModel: '',
    });
  });

  it('rejects non-string baseBranch', () => {
    assert.throws(() => Config({ baseBranch: 42 }), /baseBranch/);
  });

  it('workerCanFinish defaults false and validates booleans', () => {
    assert.deepEqual(settingsOf(Config({ workerCanFinish: true })), {
      baseBranch: '', workerCanFinish: true, workerGitMode: 'branch-automerge', commitLanguage: 'English', messageStyle: 'extended', workerModel: '',
    });
    assert.throws(() => Config({ workerCanFinish: 'yes' }), /workerCanFinish/);
  });

  it('workerGitMode defaults branch-automerge and accepts only the 3 modes', () => {
    assert.deepEqual(settingsOf(Config({ workerGitMode: 'in-place-local' })), {
      baseBranch: '', workerCanFinish: false, workerGitMode: 'in-place-local', commitLanguage: 'English', messageStyle: 'extended', workerModel: '',
    });
    assert.deepEqual(settingsOf(Config({ workerGitMode: 'in-place-push' })), {
      baseBranch: '', workerCanFinish: false, workerGitMode: 'in-place-push', commitLanguage: 'English', messageStyle: 'extended', workerModel: '',
    });
    assert.deepEqual(settingsOf(Config({ workerGitMode: 'branch-automerge' })), {
      baseBranch: '', workerCanFinish: false, workerGitMode: 'branch-automerge', commitLanguage: 'English', messageStyle: 'extended', workerModel: '',
    });
    assert.throws(() => Config({ workerGitMode: 'x' }), /workerGitMode/);
    assert.throws(() => Config({ workerGitMode: true }), /workerGitMode/);
  });

  it('commitLanguage defaults to English and validates strings', () => {
    assert.deepEqual(settingsOf(Config({ commitLanguage: 'Italian' })), {
      baseBranch: '', workerCanFinish: false, workerGitMode: 'branch-automerge',
      commitLanguage: 'Italian', messageStyle: 'extended', workerModel: '',
    });
    assert.throws(() => Config({ commitLanguage: 42 }), /commitLanguage/);
  });

  it('messageStyle defaults to extended and accepts only minimal/extended', () => {
    assert.deepEqual(settingsOf(Config({ messageStyle: 'minimal' })), {
      baseBranch: '', workerCanFinish: false, workerGitMode: 'branch-automerge',
      commitLanguage: 'English', messageStyle: 'minimal', workerModel: '',
    });
    assert.deepEqual(settingsOf(Config({ messageStyle: 'extended' })), {
      baseBranch: '', workerCanFinish: false, workerGitMode: 'branch-automerge',
      commitLanguage: 'English', messageStyle: 'extended', workerModel: '',
    });
    assert.throws(() => Config({ messageStyle: 'x' }), /messageStyle/);
    assert.throws(() => Config({ messageStyle: true }), /messageStyle/);
  });

  it('workerModel defaults to empty string and validates strings', () => {
    assert.deepEqual(settingsOf(Config({ workerModel: 'anthropic/claude-3.5-sonnet' })), {
      baseBranch: '', workerCanFinish: false, workerGitMode: 'branch-automerge',
      commitLanguage: 'English', messageStyle: 'extended', workerModel: 'anthropic/claude-3.5-sonnet',
    });
    assert.throws(() => Config({ workerModel: 42 }), /workerModel/);
  });
});

// The entry-keyed contract has one silent failure mode: the browser half asks
// configForms for SETTINGS_NS while the harness publishes the namespace under
// the patch row id. Drift there leaves every other test green while Settings
// serves built-in defaults forever.
describe('settings namespace / patch row id', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const patch = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8');

  it('SETTINGS_NS matches the inserted row id in cordis.patch.yml', () => {
    // Line-ending agnostic: an anchored `$` is fragile across CRLF checkouts.
    const ids = [...patch.matchAll(/^ {4}- id: ([^\s\r\n]+)/gm)].map((m) => m[1]);
    assert.deepEqual(ids, [SETTINGS_NS], 'exactly one inserted row, id === SETTINGS_NS');
  });

  it('the client half asks for the same id', () => {
    const client = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');
    assert.match(client, /TASKS_SETTINGS_NS = "dsh-tasks-manager"/);
    assert.match(client, /const configForms = ctx\.get\("configForms"\)/);
    assert.doesNotMatch(client, /settingsScope/);
  });
});

describe('settingsValueOf (host live read)', () => {
  it('reads the namespace through describe(), keyed by the entry id', () => {
    const service = {
      describe: () => [
        { ns: 'some-other-entry', value: { baseBranch: 'nope' } },
        { ns: SETTINGS_NS, value: { baseBranch: 'main', workerCanFinish: true } },
      ],
    };
    assert.deepEqual(settingsValueOf(service), { baseBranch: 'main', workerCanFinish: true });
  });

  it('is safe on a missing service, a missing namespace and a throwing one', () => {
    assert.equal(settingsValueOf(undefined), undefined);
    assert.equal(settingsValueOf({}), undefined);
    assert.equal(settingsValueOf({ describe: () => [] }), undefined);
    assert.equal(settingsValueOf({ describe: () => { throw new Error('boom'); } }), undefined);
  });
});
