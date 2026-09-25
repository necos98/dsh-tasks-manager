import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Minimal client-half harness: lib/client.js is a side-effect module that only
// registers a factory on window.__ModuleLoader__. We capture the module, run
// the factory with a react stub, and read the stylesheet the factory injects
// into the stubbed <head>.
const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url));

function loadClientHalf() {
  let captured = null;
  let styleText = null;
  const documentStub = {
    querySelector: () => null,
    createElement: () => ({
      dataset: {},
      set textContent(value) { styleText = value; },
      get textContent() { return styleText; },
    }),
    head: { appendChild: () => {} },
  };
  globalThis.window = { __ModuleLoader__: { load: (mod) => { captured = mod; } } };
  globalThis.document = documentStub;
  return { get captured() { return captured; }, get styleText() { return styleText; } };
}

describe('client stylesheet', () => {
  let styleText;

  before(async () => {
    const harness = loadClientHalf();
    await import('../lib/client.js');
    assert.ok(harness.captured, 'window.__ModuleLoader__.load was called');
    harness.captured.factory(() => ({ createElement: () => null }));
    styleText = harness.styleText;
  });

  it('injects the panel stylesheet', () => {
    assert.equal(typeof styleText, 'string');
    assert.ok(styleText.length > 0);
  });

  it('keeps the error box selectors intact', () => {
    assert.ok(styleText.includes('._tskError{'), '._tskError rule is present');
    assert.ok(styleText.includes('._tskErrorText{'), '._tskErrorText rule is present');
  });

  it('emits no NaN selector from a stray unary plus', () => {
    assert.ok(!styleText.includes('NaN'), 'no NaN substring in the stylesheet');
  });

  it('source has no "+ +" concatenation at end of line', () => {
    const source = readFileSync(CLIENT_PATH, 'utf8');
    const offenders = source.split(/\r?\n/).filter((line) => /\+\s*\+\s*$/.test(line));
    assert.deepEqual(offenders, [], 'stray unary plus in concatenation');
  });
});
