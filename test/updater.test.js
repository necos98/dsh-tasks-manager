// lib/updater.js — the manual GitHub updater domain. Injected deps only:
// no network, no shell, no DSH boot.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_REPOSITORY,
  createUpdater,
  installSpecFor,
  isNewer,
  normalizeRepository,
  parseLsRemoteTags,
  parseTag,
  pickLatest,
  readInstalledVersion,
  resolveProfileDir,
  updaterSettings,
} from '../lib/updater.js';

const PROFILE = join('C:', 'profiles', 'web');

function settings(overrides = {}) {
  return {
    repository: DEFAULT_REPOSITORY,
    packageName: 'dsh-tasks-manager',
    profile: '',
    includePrerelease: false,
    timeoutMs: 1000,
    token: '',
    ...overrides,
  };
}

// One updater with every machine-touching dependency replaced.
function makeUpdater({ deps = {}, settings: overrides = {}, profileDir = PROFILE, profileError } = {}) {
  const calls = { installs: [], tags: 0 };
  const base = {
    fetchTags: async () => { calls.tags += 1; return { source: 'git', tags: [] }; },
    runInstall: () => ({ status: 0, method: 'dsh', output: 'added 1 package', notFound: false }),
    readVersion: () => '0.1.0',
    isLinked: () => false,
  };
  const merged = { ...base, ...deps };
  const wrapped = {
    fetchTags: merged.fetchTags,
    isLinked: merged.isLinked,
    readVersion: merged.readVersion,
    runInstall: async (request) => {
      calls.installs.push(request);
      return merged.runInstall(request);
    },
  };
  const updater = createUpdater({
    settings: settings(overrides),
    profileDir,
    profileError,
    deps: wrapped,
  });
  return { updater, calls };
}

describe('updater: release-tag arithmetic', () => {
  it('parses vX.Y.Z and X.Y.Z, with an optional prerelease', () => {
    assert.deepEqual(parseTag('v1.2.3'), { raw: 'v1.2.3', major: 1, minor: 2, patch: 3, prerelease: '' });
    assert.deepEqual(parseTag(' 1.2.3 '), { raw: '1.2.3', major: 1, minor: 2, patch: 3, prerelease: '' });
    assert.equal(parseTag('1.2.3-rc.1').prerelease, 'rc.1');
  });

  it('rejects everything that is not a plain release version', () => {
    for (const bad of ['main', 'v1.2', 'refs/tags/v1.2.3', 'v1.2.3.4', 'release-1.2.3', '', 'v1.2.3+meta']) {
      assert.equal(parseTag(bad), undefined, bad);
    }
  });

  it('compares numerically, so v0.10.0 beats v0.9.9', () => {
    assert.equal(isNewer('v0.10.0', 'v0.9.9'), true);
    assert.equal(isNewer('0.2.0', 'v0.2.0'), false);
    assert.equal(isNewer('v0.2.0', '0.2.0'), false);
    assert.equal(isNewer('v0.1.0', 'v0.1.0'), false);
  });

  it('ranks a prerelease below its release and compares identifiers', () => {
    assert.equal(isNewer('v0.2.0', 'v0.2.0-rc.1'), true);
    assert.equal(isNewer('v0.2.0-rc.2', 'v0.2.0-rc.10'), false);
    assert.equal(isNewer('nonsense', 'v0.1.0'), false);
  });

  it('pickLatest returns the tag as published, skipping prereleases by default', () => {
    assert.equal(pickLatest(['v0.9.9', 'v0.10.0', 'v0.1.0']), 'v0.10.0');
    assert.equal(pickLatest(['0.1.0', 'v0.2.0-rc.1']), '0.1.0');
    assert.equal(pickLatest(['0.1.0', 'v0.2.0-rc.1'], { includePrerelease: true }), 'v0.2.0-rc.1');
    assert.equal(pickLatest(['main', 'v0.3.0', 'nightly']), 'v0.3.0');
    assert.equal(pickLatest(['main', 'nightly']), undefined);
    assert.equal(pickLatest([]), undefined);
  });
});

describe('updater: tag lookup helpers', () => {
  it('normalizes git specs, URLs and bare pairs', () => {
    assert.equal(normalizeRepository('git+https://github.com/necos98/dsh-tasks-manager.git'), 'necos98/dsh-tasks-manager');
    assert.equal(normalizeRepository('https://github.com/necos98/dsh-tasks-manager.git/'), 'necos98/dsh-tasks-manager');
    assert.equal(normalizeRepository('git@github.com:necos98/dsh-tasks-manager.git'), 'necos98/dsh-tasks-manager');
    assert.equal(normalizeRepository(' necos98/dsh-tasks-manager '), 'necos98/dsh-tasks-manager');
  });

  it('reads refs/tags lines only, dropping peeled duplicates', () => {
    const output = [
      '9f2a1c\trefs/tags/v0.1.0',
      '4b7d0e\trefs/tags/v0.1.0^{}',
      'aa11bb\trefs/tags/v0.1.1',
      'cc22dd\trefs/heads/master',
      '',
    ].join('\n');
    assert.deepEqual(parseLsRemoteTags(output), ['v0.1.0', 'v0.1.1']);
    assert.deepEqual(parseLsRemoteTags(''), []);
  });

  it('builds the install spec with the published tag', () => {
    assert.equal(installSpecFor('necos98/dsh-tasks-manager', 'v0.1.1'), 'github:necos98/dsh-tasks-manager#v0.1.1');
    assert.equal(installSpecFor('https://github.com/necos98/dsh-tasks-manager.git', '0.1.1'), 'github:necos98/dsh-tasks-manager#0.1.1');
  });

  it('maps the plugin config to updater settings with safe defaults', () => {
    const mapped = updaterSettings({ updateRepository: '', updateProfile: ' web ', updateIncludePrerelease: true, updateTimeoutMs: 5, updateToken: 't' });
    assert.equal(mapped.repository, DEFAULT_REPOSITORY);
    assert.equal(mapped.profile, 'web');
    assert.equal(mapped.includePrerelease, true);
    assert.equal(mapped.timeoutMs, 5);
    assert.equal(mapped.token, 't');
    assert.equal(updaterSettings({}).timeoutMs, 180000);
  });
});

describe('updater: profile on disk', () => {
  it('reads the installed version, null on ENOENT, throws on malformed JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'tasks-updater-'));
    try {
      const dir = join(root, 'node_modules', 'dsh-tasks-manager');
      mkdirSync(dir, { recursive: true });
      assert.equal(readInstalledVersion(root, 'dsh-tasks-manager'), null);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.1.0' }));
      assert.equal(readInstalledVersion(root, 'dsh-tasks-manager'), '0.1.0');
      writeFileSync(join(dir, 'package.json'), '{ not json');
      assert.throws(() => readInstalledVersion(root, 'dsh-tasks-manager'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolveProfileDir prefers the override, then the baseUrl marker, then throws', () => {
    const root = mkdtempSync(join(tmpdir(), 'tasks-profile-'));
    try {
      assert.equal(resolveProfileDir({ override: root, baseUrl: 'file:///nope/' }), root);
      writeFileSync(join(root, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }));
      assert.equal(resolveProfileDir({ baseUrl: pathToFileURL(join(root, 'cordis.patch.yml')).href }), root);
      const bare = mkdtempSync(join(tmpdir(), 'tasks-noprofile-'));
      try {
        // No profile marker anywhere up the tree from this checkout either.
        assert.throws(() => resolveProfileDir({ baseUrl: pathToFileURL(join(bare, 'cordis.patch.yml')).href }), /cannot locate the DSH profile directory/);
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('updater: updateStatus', () => {
  it('answers without touching the network or the shell', async () => {
    const { updater, calls } = makeUpdater({ deps: { readVersion: () => '0.1.0' } });
    const out = await updater('updateStatus');
    assert.equal(out.ok, true);
    assert.equal(out.value.repository, DEFAULT_REPOSITORY);
    assert.equal(out.value.profile, 'web');
    assert.equal(out.value.packageName, 'dsh-tasks-manager');
    assert.equal(out.value.installed, true);
    assert.equal(out.value.current, '0.1.0');
    assert.equal(out.value.linked, false);
    assert.equal(out.value.channel, 'stable');
    assert.equal(calls.tags, 0);
    assert.equal(calls.installs.length, 0);
    assert.equal(out.value.profileDir, PROFILE);
  });

  it('reports a local link and the prerelease channel', async () => {
    const { updater } = makeUpdater({ deps: { isLinked: () => true }, settings: { includePrerelease: true } });
    const out = await updater('updateStatus');
    assert.equal(out.value.linked, true);
    assert.equal(out.value.channel, 'prerelease');
  });
});

describe('updater: checkUpdate', () => {
  it('answers no-release with the tag recipe when the repository has no tag', async () => {
    const { updater } = makeUpdater({ deps: { fetchTags: async () => ({ source: 'git', tags: [] }) } });
    const out = await updater('checkUpdate');
    assert.equal(out.ok, true);
    assert.equal(out.value.status, 'no-release');
    assert.equal(out.value.latest, null);
    assert.match(out.value.notes.join('\n'), /git tag vX\.Y\.Z && git push origin vX\.Y\.Z/);
  });

  it('answers update-available when the newest tag is newer', async () => {
    const { updater } = makeUpdater({
      deps: { fetchTags: async () => ({ source: 'git', tags: ['v0.1.0', 'v0.1.1'] }), readVersion: () => '0.1.0' },
    });
    const out = await updater('checkUpdate');
    assert.equal(out.value.status, 'update-available');
    assert.equal(out.value.current, '0.1.0');
    assert.equal(out.value.latest, 'v0.1.1');
    assert.equal(out.value.source, 'git');
  });

  it('answers up-to-date when the installed version is the newest tag', async () => {
    const { updater } = makeUpdater({
      deps: { fetchTags: async () => ({ source: 'git', tags: ['v0.1.0'] }), readVersion: () => '0.1.0' },
    });
    const out = await updater('checkUpdate');
    assert.equal(out.value.status, 'up-to-date');
  });

  it('answers not-installed when the profile has no copy', async () => {
    const { updater } = makeUpdater({
      deps: { fetchTags: async () => ({ source: 'git', tags: ['v0.1.1'] }), readVersion: () => null },
    });
    const out = await updater('checkUpdate');
    assert.equal(out.value.status, 'not-installed');
    assert.equal(out.value.current, null);
    assert.equal(out.value.latest, 'v0.1.1');
  });

  it('answers error, not a rejection, when the tag lookup fails', async () => {
    const { updater } = makeUpdater({
      deps: { fetchTags: async () => { throw new Error('cannot read the tags of necos98/dsh-tasks-manager'); } },
    });
    const out = await updater('checkUpdate');
    assert.equal(out.ok, true);
    assert.equal(out.value.status, 'error');
    assert.match(out.value.error.message, /cannot read the tags/);
    assert.match(out.value.notes.join('\n'), /cannot read the tags/);
  });

  it('treats an unparsable installed version as older than the newest release', async () => {
    const { updater } = makeUpdater({
      deps: { fetchTags: async () => ({ source: 'git', tags: ['v0.1.1'] }), readVersion: () => 'main-build' },
    });
    const out = await updater('checkUpdate');
    assert.equal(out.value.status, 'update-available');
    assert.match(out.value.notes.join('\n'), /"main-build" is not a release version/);
  });

  it('ignores prereleases unless configured and says how many it skipped', async () => {
    const tags = ['v0.1.0', 'v0.2.0-rc.1', 'v0.2.0-rc.2'];
    const skipped = makeUpdater({
      deps: { fetchTags: async () => ({ source: 'git', tags }), readVersion: () => '0.1.0' },
    });
    const out = await skipped.updater('checkUpdate');
    assert.equal(out.value.status, 'up-to-date');
    assert.match(out.value.notes.join('\n'), /2 prerelease tag\(s\) ignored/);

    const included = makeUpdater({
      deps: { fetchTags: async () => ({ source: 'git', tags }), readVersion: () => '0.1.0' },
      settings: { includePrerelease: true },
    });
    const io = await included.updater('checkUpdate');
    assert.equal(io.value.latest, 'v0.2.0-rc.2');
    assert.equal(io.value.status, 'update-available');
  });

  it('answers error with the reason when the profile cannot be located', async () => {
    const { updater } = makeUpdater({ profileDir: null, profileError: 'cannot locate the DSH profile directory' });
    const out = await updater('checkUpdate');
    assert.equal(out.value.status, 'error');
    assert.match(out.value.error.message, /cannot locate the DSH profile directory/);
  });
});

describe('updater: applyUpdate', () => {
  it('refuses without a profile directory', async () => {
    const { updater } = makeUpdater({ profileDir: null, profileError: 'cannot locate the DSH profile directory' });
    const out = await updater('applyUpdate', {});
    assert.equal(out.ok, false);
    assert.match(out.error.message, /cannot locate the DSH profile directory/);
  });

  it('refuses a linked install', async () => {
    const { updater, calls } = makeUpdater({ deps: { isLinked: () => true } });
    const out = await updater('applyUpdate', {});
    assert.equal(out.ok, false);
    assert.match(out.error.message, /local link/);
    assert.match(out.error.message, /update it in its own checkout/);
    assert.equal(calls.installs.length, 0);
  });

  it('refuses when updateProfile names a different profile', async () => {
    const { updater, calls } = makeUpdater({ settings: { profile: 'other' } });
    const out = await updater('applyUpdate', {});
    assert.equal(out.ok, false);
    assert.match(out.error.message, /updateProfile is "other"/);
    assert.equal(calls.installs.length, 0);
  });

  it('re-reads the tags and refuses a stale page unless forced', async () => {
    const installs = [];
    const { updater } = makeUpdater({
      deps: {
        fetchTags: async () => ({ source: 'git', tags: ['v0.1.0'] }),
        readVersion: () => '0.1.0',
        runInstall: (request) => { installs.push(request); return { status: 0, method: 'dsh', output: 'ok', notFound: false }; },
      },
    });
    const stale = await updater('applyUpdate', {});
    assert.equal(stale.ok, false);
    assert.match(stale.error.message, /nothing to update/);
    assert.equal(installs.length, 0);
  });

  it('installs the newest tag, then reports the version on disk and the restart', async () => {
    const versions = ['0.1.0', '0.1.1'];
    const installs = [];
    const { updater } = makeUpdater({
      deps: {
        fetchTags: async () => ({ source: 'git', tags: ['v0.1.0', 'v0.1.1'] }),
        readVersion: () => versions.shift(),
        runInstall: (request) => {
          installs.push(request);
          return { status: 0, method: 'dsh', output: 'Progress: resolved 1, reused 0\nadded 1 package', notFound: false };
        },
      },
    });
    const out = await updater('applyUpdate', {});
    assert.equal(out.ok, true);
    assert.equal(out.value.updated, true);
    assert.equal(out.value.previous, '0.1.0');
    assert.equal(out.value.current, '0.1.1');
    assert.equal(out.value.latest, 'v0.1.1');
    assert.equal(out.value.restartRequired, true);
    assert.equal(out.value.installSpec, 'github:necos98/dsh-tasks-manager#v0.1.1');
    assert.match(out.value.output, /added 1 package/);
    assert.deepEqual(installs, [{
      profileDir: PROFILE,
      spec: 'github:necos98/dsh-tasks-manager#v0.1.1',
      profile: 'web',
      timeoutMs: 1000,
    }]);
  });

  it('force reinstalls an already newest tag', async () => {
    const versions = ['0.1.0', '0.1.0'];
    const { updater } = makeUpdater({
      deps: {
        fetchTags: async () => ({ source: 'git', tags: ['v0.1.0'] }),
        readVersion: () => versions.shift(),
      },
    });
    const out = await updater('applyUpdate', { force: true });
    assert.equal(out.ok, true);
    assert.equal(out.value.updated, false);
  });

  it('keeps the package manager output tail inside the failure', async () => {
    const tail = Array.from({ length: 50 }, (_, i) => 'line ' + (i + 1)).join('\n');
    const { updater } = makeUpdater({
      deps: {
        fetchTags: async () => ({ source: 'git', tags: ['v0.1.1'] }),
        runInstall: () => ({ status: 1, method: 'pnpm', output: tail, notFound: true }),
      },
    });
    const out = await updater('applyUpdate', {});
    assert.equal(out.ok, false);
    assert.match(out.error.message, /pnpm could not install github:necos98\/dsh-tasks-manager#v0\.1\.1/);
    assert.match(out.error.message, /line 50/);
    assert.doesNotMatch(out.error.message, /line 1\n/);
  });

  it('serializes installs, so two tabs never run two package managers', async () => {
    let active = 0;
    let peak = 0;
    const { updater } = makeUpdater({
      deps: {
        fetchTags: async () => ({ source: 'git', tags: ['v0.1.1'] }),
        runInstall: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 10));
          active -= 1;
          return { status: 0, method: 'dsh', output: 'ok', notFound: false };
        },
      },
    });
    const [a, b] = await Promise.all([updater('applyUpdate', {}), updater('applyUpdate', {})]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(peak, 1);
  });

  it('answers unknown updater methods instead of throwing', async () => {
    const { updater } = makeUpdater();
    const out = await updater('nope');
    assert.equal(out.ok, false);
    assert.match(out.error.message, /unknown updater method "nope"/);
  });
});
