import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { xmdLink } from '../extension/link.js';
import { copyText } from '../extension/clipboard.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');

test('xmdLink encodes http(s) URLs and rejects others', () => {
  assert.equal(
    xmdLink('https://example.com/a?b=c&d=e'),
    'https://xmd.imfrank.dev/?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc%26d%3De',
  );
  assert.equal(xmdLink('chrome://extensions'), null);
  assert.equal(xmdLink('file:///tmp/x'), null);
  assert.equal(xmdLink(''), null);
  assert.equal(xmdLink(undefined), null);
});

test('extension manifest is MV3 with only activeTab and clipboardWrite', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['activeTab', 'clipboardWrite']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  const files = new Set([
    manifest.action.default_popup,
    manifest.background.service_worker,
    ...Object.values(manifest.action.default_icon),
    ...Object.values(manifest.icons),
  ]);
  const html = readFileSync(join(root, manifest.action.default_popup), 'utf8');
  for (const src of html.matchAll(/src="([^"]+)"/g)) files.add(src[1]);
  const popupJs = readFileSync(join(root, 'popup.js'), 'utf8');
  for (const src of popupJs.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) files.add(src[1]);
  for (const file of files) {
    assert.ok(existsSync(join(root, file)), file);
  }
  for (const [size, file] of Object.entries(manifest.icons)) {
    const buf = readFileSync(join(root, file));
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(buf.toString('ascii', 12, 16), 'IHDR');
    assert.equal(buf.readUInt32BE(16), Number(size));
    assert.equal(buf.readUInt32BE(20), Number(size));
  }
});

function stubClipboard({ writeText, execCommand }) {
  const textarea = {
    value: '',
    style: {},
    setAttribute() {},
    focus() { this.focused = true; },
    select() { this.selected = true; },
    remove() { this.removed = true; },
  };
  let execCalls = 0;
  const define = (name, value) => Object.defineProperty(globalThis, name, {
    value, configurable: true, writable: true, enumerable: true,
  });
  define('window', {
    focus() { this.didFocus = true; },
    addEventListener() {},
    removeEventListener() {},
  });
  define('document', {
    hasFocus() { return true; },
    body: {
      appendChild(el) { this.child = el; },
    },
    createElement(tag) {
      assert.equal(tag, 'textarea');
      return textarea;
    },
    execCommand(cmd) {
      execCalls += 1;
      assert.equal(cmd, 'copy');
      return execCommand(cmd);
    },
  });
  define('navigator', { clipboard: { writeText } });
  return { textarea, execCalls: () => execCalls };
}

test('copyText uses execCommand when it succeeds and does not call writeText', async () => {
  const written = [];
  const stubs = stubClipboard({
    writeText: async text => { written.push(text); },
    execCommand: () => true,
  });
  assert.equal(await copyText('https://xmd.imfrank.dev/?url=https%3A%2F%2Fexample.com'), true);
  assert.deepEqual(written, []);
  assert.equal(stubs.execCalls(), 1);
  assert.equal(stubs.textarea.value, 'https://xmd.imfrank.dev/?url=https%3A%2F%2Fexample.com');
  assert.equal(stubs.textarea.removed, true);
});

test('copyText falls back to writeText when execCommand returns false', async () => {
  const written = [];
  const stubs = stubClipboard({
    writeText: async text => { written.push(text); },
    execCommand: () => false,
  });
  assert.equal(await copyText('hello'), true);
  assert.deepEqual(written, ['hello']);
  assert.equal(stubs.execCalls(), 1);
});

test('copyText returns false when execCommand and writeText both fail', async () => {
  stubClipboard({
    writeText: async () => { throw new Error('Document is not focused.'); },
    execCommand: () => false,
  });
  assert.equal(await copyText('hello'), false);
});
