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
  { id: 'taskqueue-team-intake', name: 'Team Task Intake', order: 12 },
];

describe('preset declarations (bundle patches)', () => {
  it('the bundle patch list carries the plugin row first, then every shipped preset', () => {
    assert.deepEqual(patchList(), [
      './cordis.patch.yml',
      './presets/taskqueue-intake.patch.yml',
      './presets/taskqueue-worker.patch.yml',
      './presets/taskqueue-team-intake.patch.yml',
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

  it('every preset mounts the web tools, and the intake stays write-free', () => {
    // Content pin: dsh-tool-web gives web_search + web_fetch to BOTH taskqueue
    // agents, with the row id and config the shipped `standard` preset uses. The
    // web row and the no-write-tools guarantee are asserted TOGETHER here: a
    // web read must never come at the price of a write tool.
    for (const { id } of PRESETS) {
      const text = shipped('presets/' + id + '.patch.yml');
      assert.match(text, /^ {10}- id: tool-web$/m, id + ' mounts no tool-web row');
      const row = /^ {10}- id: tool-web\n(?: {12}.*\n)+/m.exec(text);
      assert.ok(row, id + ' tool-web row has no config block');
      assert.match(row[0], /^ {12}name: '@deepseek-ai\/dsh-tool-web'$/m, id + ' tool-web name');
      assert.match(row[0], /^ {14}fetch: true$/m, id + ' tool-web fetch');
      assert.match(row[0], /^ {14}searchTimeoutMs: 60000$/m, id + ' tool-web searchTimeoutMs');
    }
    const intake = shipped('presets/taskqueue-intake.patch.yml');
    assert.doesNotMatch(intake, /name: '@deepseek-ai\/dsh-tool-fs'/);
    assert.doesNotMatch(intake, /name: '[^']*str_replace_editor'/);
  });

  it('the team intake preset is the read-only intake surface orchestrated as a team', () => {
    // The experimental preset reuses the intake surface verbatim and delegates
    // instead. Two properties make it safe: (1) it stays write-free, so a
    // teammate that inherits this preset cannot mutate anything, and (2) it
    // declares NO delegation row — the Agent Teams tools are host-plane and
    // land in each agent's own scope on agent/created, so mounting one here
    // would be a wrong mount rather than a delegation policy.
    const text = shipped('presets/taskqueue-team-intake.patch.yml');
    assert.match(text, /name: 'dsh-tasks-manager\/read-tool'/);
    assert.match(text, /name: 'dsh-tasks-manager\/intake-tools'/);
    assert.doesNotMatch(text, /name: '@deepseek-ai\/dsh-tool-fs'/);
    assert.doesNotMatch(text, /name: '[^']*str_replace_editor'/);
    // No delegation ROW. The plain form of the team-tool pin is anchored to a
    // `name:` row on purpose: the declaration NAMES that package in its header
    // prose (explaining why it is host-plane), so an unanchored doesNotMatch
    // would forbid documenting the very design this preset relies on.
    assert.doesNotMatch(text, /@deepseek-ai\/dsh-tool-subagent/);
    assert.doesNotMatch(text, /@deepseek-ai\/dsh-tool-workflow/);
    assert.doesNotMatch(text, /@deepseek-ai\/dsh-tool-ralph/);
    assert.doesNotMatch(text, /^\s*name: ['"]@deepseek-ai\/dsh-experimental-tool-agent-team['"]$/m);
    // The persona must serve BOTH roles: teammates inherit the lead's preset, so
    // the same text is the only thing telling a teammate what it is and what it
    // may never do. Drop any of these pins and the team silently degrades into
    // teammates that answer the user or file drafts of their own.
    for (const needle of [
      'Team Lead',
      'teammate',
      'spawn_teammate',
      'send_message',
      'list_agents',
      'wait_agent',
      'team_task_create',
      'team_task_update',
      'Never call enqueue_task',
      'does not apply here',
      'enqueue_task',
      'edit_draft',
      'search_tasks',
    ]) {
      assert.ok(text.includes(needle), 'persona dropped: ' + needle);
    }
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
    assert.deepEqual([...SETTINGS_KEYS].sort(), ['baseBranch', 'commitLanguage', 'messageStyle', 'workerCanFinish', 'workerGitMode', 'workerModel']);
  });

  it('worker preset names the spawn language/style instead of hardcoding English', () => {
    const text = shipped('presets/taskqueue-worker.patch.yml');
    assert.doesNotMatch(text, /ALWAYS English/);
    assert.doesNotMatch(text, /stays English regardless/);
    assert.doesNotMatch(text, /commits and reports always English/);
    assert.match(text, /Commit\/PR language \+ Message style lines/);
    assert.match(text, /spawn language/);
  });

  it('worker preset gates the 3 git modes on the spawn message (--no-ff, abort on conflict)', () => {
    // Content pin: future preset edits must not silently drop a mode section
    // or the merge/conflict discipline. Reads the SHIPPED declaration.
    const text = shipped('presets/taskqueue-worker.patch.yml');
    assert.match(text, /## Branch-automerge mode \(ONLY when spawn says git mode is branch-automerge\)/);
    assert.match(text, /## In-place-local mode \(ONLY when spawn says git mode is in-place-local\)/);
    assert.match(text, /## In-place-push mode \(ONLY when spawn says git mode is in-place-push\)/);
    assert.match(text, /Git mode for this task is <mode>/);
    assert.match(text, /## Auto-merge/);
    assert.match(text, /git merge --no-ff <branch>/);
    assert.match(text, /git merge --abort/);
    assert.match(text, /FORBIDDEN to unblock yourself/);
    assert.match(text, /--theirs\/--ours/);
    assert.match(text, /The task stays open/);
    assert.match(text, /git status --porcelain/);
    assert.match(text, /\(task #<seq>\)/);
    // In-place modes never touch another branch, the base, a PR or a merge.
    assert.match(text, /NEVER open a PR, NEVER merge, NEVER push/);
    assert.match(text, /task\.branch is history\s+only/);
    // The spawn message (not memory) is authoritative for the modes.
    assert.match(text, /that line\s+is authoritative,\s+NOT your memory/);
  });
});
