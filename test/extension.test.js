import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { xmdLink } from '../extension/link.js';

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
