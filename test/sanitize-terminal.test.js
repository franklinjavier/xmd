import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTerminal } from '../src/sanitize-terminal.js';
import { help } from '../src/cli.js';

test('sanitizeTerminal strips CSI, OSC, other ESC, C0, C1; keeps tab and newline', () => {
  assert.equal(sanitizeTerminal('ok\x1b[31mRED\x1b[0m'), 'okRED');
  assert.equal(sanitizeTerminal('x\x1b]8;;https://evil\x07y'), 'xy');
  assert.equal(sanitizeTerminal('x\x1b]0;title\x1b\\y'), 'xy');
  assert.equal(sanitizeTerminal('a\x1bcb'), 'ab');
  assert.equal(sanitizeTerminal('a\r\nb\tc'), 'a\nb\tc');
  assert.equal(sanitizeTerminal('a\x00b\x7fc\x9fd'), 'abcd');
  assert.match(help, /--raw/);
});
