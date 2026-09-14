// Read windowing: the pure half of the intake preset's read-only `read` tool.
// No DSH boot — the caps, the offset window, the footer and the out-of-range
// error are all plain functions.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BYTES, MAX_LINE_LENGTH, READ_LIMIT, formatReadOutput, parseReadArgs, windowOf } from '../lib/read-window.js';

const req = (over = {}) => ({ offset: 1, limit: READ_LIMIT, ...over });

describe('parseReadArgs', () => {
  it('defaults offset to 1 and limit to the cap', () => {
    assert.deepEqual(parseReadArgs({ file_path: 'a.js' }, READ_LIMIT), { filePath: 'a.js', offset: 1, limit: READ_LIMIT });
  });

  it('rejects a blank path, a non-positive offset/limit and an over-cap limit', () => {
    assert.throws(() => parseReadArgs({ file_path: '   ' }, READ_LIMIT), /non-empty string/);
    assert.throws(() => parseReadArgs({ file_path: 'a', offset: 0 }, READ_LIMIT), /offset/);
    assert.throws(() => parseReadArgs({ file_path: 'a', limit: 1.5 }, READ_LIMIT), /limit/);
    assert.throws(() => parseReadArgs({ file_path: 'a', limit: READ_LIMIT + 1 }, READ_LIMIT), /less than or equal/);
  });
});

describe('windowOf', () => {
  it('numbers lines from 1 and ignores a trailing newline', () => {
    const w = windowOf('one\ntwo\nthree\n', req(), 'f.txt');
    assert.deepEqual(w.lines, [
      { number: 1, text: 'one' },
      { number: 2, text: 'two' },
      { number: 3, text: 'three' },
    ]);
    assert.equal(w.totalLines, 3);
    assert.equal(w.truncatedByBytes, false);
  });

  it('strips CR so a CRLF checkout reads as LF', () => {
    assert.deepEqual(windowOf('a\r\nb\r\n', req(), 'f.txt').lines, [
      { number: 1, text: 'a' },
      { number: 2, text: 'b' },
    ]);
  });

  it('counts an empty file as zero lines and accepts offset 1', () => {
    const w = windowOf('', req(), 'f.txt');
    assert.deepEqual(w.lines, []);
    assert.equal(w.totalLines, 0);
  });

  it('windows by offset and limit while still counting every line', () => {
    const w = windowOf('a\nb\nc\nd\n', req({ offset: 2, limit: 2 }), 'f.txt');
    assert.deepEqual(w.lines, [
      { number: 2, text: 'b' },
      { number: 3, text: 'c' },
    ]);
    assert.equal(w.totalLines, 4);
  });

  it('throws when offset is past EOF but not for an empty file at offset 1', () => {
    assert.throws(() => windowOf('a\n', req({ offset: 5 }), 'f.txt'), /out of range/);
    assert.throws(() => windowOf('', req({ offset: 2 }), 'f.txt'), /out of range/);
    assert.doesNotThrow(() => windowOf('', req({ offset: 1 }), 'f.txt'));
  });

  it('caps by bytes and flags the truncation', () => {
    const w = windowOf('aaaa\nbbbb\ncccc\n', req({ maxBytes: 10 }), 'f.txt');
    assert.deepEqual(w.lines, [
      { number: 1, text: 'aaaa' },
      { number: 2, text: 'bbbb' },
    ]);
    assert.equal(w.truncatedByBytes, true);
    assert.equal(w.totalLines, 3);
  });

  it('truncates an over-long line with the canonical suffix', () => {
    const w = windowOf('x'.repeat(MAX_LINE_LENGTH + 10), req(), 'f.txt');
    assert.equal(w.lines[0].text.length, MAX_LINE_LENGTH + '... (line truncated to 2000 chars)'.length);
    assert.match(w.lines[0].text, /\.\.\. \(line truncated to 2000 chars\)$/);
  });

  it('MAX_BYTES is the default byte cap', () => {
    const text = Array.from({ length: 200 }, () => 'y'.repeat(1000)).join('\n');
    const w = windowOf(text, req(), 'f.txt');
    assert.equal(w.truncatedByBytes, true);
    assert.ok(w.lines.reduce((n, l) => n + Buffer.byteLength(l.text, 'utf8') + 1, 0) <= MAX_BYTES + 1);
  });
});

describe('formatReadOutput', () => {
  it('renders numbered lines with the end-of-file footer', () => {
    const out = formatReadOutput('f.txt', { offset: 1, lines: [{ number: 1, text: 'a' }], totalLines: 1, truncatedByBytes: false });
    assert.equal(out, '<path>f.txt</path>\n<type>file</type>\n<content>\n1: a\n\n(End of file - total 1 lines)\n</content>');
  });

  it('renders the continuation footer with the next offset', () => {
    const out = formatReadOutput('f.txt', { offset: 1, lines: [{ number: 1, text: 'a' }, { number: 2, text: 'b' }], totalLines: 9, truncatedByBytes: false });
    assert.match(out, /\(Showing lines 1-2 of 9\. Use offset=3 to continue\.\)/);
  });

  it('renders the byte-cap footer distinctly', () => {
    const out = formatReadOutput('f.txt', { offset: 1, lines: [{ number: 1, text: 'a' }], totalLines: 9, truncatedByBytes: true });
    assert.match(out, /\(Output capped\. Showing lines 1-1\. Use offset=2 to continue\.\)/);
  });

  it('renders an empty window as just the footer', () => {
    const out = formatReadOutput('f.txt', { offset: 1, lines: [], totalLines: 0, truncatedByBytes: false });
    assert.equal(out, '<path>f.txt</path>\n<type>file</type>\n<content>\n(End of file - total 0 lines)\n</content>');
  });
});
