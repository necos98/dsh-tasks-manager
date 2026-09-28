import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Encoding guard: lib/client.js carries the panel's shared display glyphs
// (reorder icons, chevron, close, ellipsis, em dash, arrow). A UTF-8 file read
// as Windows-1252 and written back as UTF-8 double-encodes every glyph into a
// constant 3-character mojibake run. This guard pins the file to its single-
// encoded UTF-8 form so the corruption cannot be reintroduced silently.
const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url));

// Each entry is the exact double-encoded run the corruption produced; the
// comment names the glyph it must decode back to.
const MOJIBAKE_RUNS = [
  '\u00E2\u2013\u00B2', // ▲
  '\u00E2\u2013\u00BC', // ▼
  '\u00E2\u2013\u00BE', // ▾
  '\u00E2\u0153\u2022', // ✕
  '\u00E2\u20AC\u00A6', // …
  '\u00E2\u20AC\u201D', // —
  '\u00E2\u2020\u2019', // →
];

const DISPLAY_GLYPHS = ['\u25B2', '\u25BC', '\u25BE', '\u2715', '\u2026', '\u2014', '\u2192'];

describe('client encoding', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8');

  it('contains no double-encoded mojibake run', () => {
    for (const run of MOJIBAKE_RUNS) {
      const count = source.split(run).length - 1;
      assert.equal(count, 0, `double-encoded run ${JSON.stringify(run)} appears ${count} time(s)`);
    }
  });

  it('contains no replacement character and no stray latin-1 lead byte', () => {
    assert.equal(source.split('\uFFFD').length - 1, 0, 'no U+FFFD in the source');
    assert.ok(!/\u00C3|\u00E2[\u0080-\u00FF]/.test(source), 'no stray latin-1 mojibake bytes');
    assert.ok(!source.includes('\u00E2'), 'no U+00E2 lead byte anywhere in the source');
  });

  it('carries the restored display glyphs', () => {
    for (const glyph of DISPLAY_GLYPHS) {
      assert.ok(source.includes(glyph), `missing display glyph ${glyph}`);
    }
  });

  it('keeps the Queued-group reorder render path literal intact', () => {
    assert.ok(
      source.includes('direction === "up" ? "\u25B2" : "\u25BC"'),
      'reorder buttons render the up/down icons',
    );
  });
});
