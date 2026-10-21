import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTargetUrl } from '../src/page.js';
import { handle, createMemoryLimiter } from '../src/worker.js';

function memoryCache() {
  const store = new Map();
  return {
    async match(request) {
      const key = typeof request === 'string' ? request : request.url;
      const hit = store.get(key);
      return hit ? hit.clone() : undefined;
    },
    async put(request, response) {
      const key = typeof request === 'string' ? request : request.url;
      store.set(key, response.clone());
    },
  };
}

async function call(path, { method = 'GET', ip, env = {}, ...deps } = {}) {
  const pending = [];
  const ctx = { waitUntil(p) { pending.push(p); } };
  const headers = {};
  if (ip) headers['cf-connecting-ip'] = ip;
  const response = await handle(new Request(`https://xmd.test${path}`, { method, headers }), env, ctx, { render: async () => 'markdown', ...deps });
  await Promise.all(pending);
  return response;
}

const allow = async () => ['93.184.216.34'];

test('normalizeTargetUrl prefixes https for scheme-less and protocol-relative URLs', () => {
  assert.equal(normalizeTargetUrl('zietec.io').href, 'https://zietec.io/');
  assert.equal(normalizeTargetUrl('www.zietec.io/path?q=1').href, 'https://www.zietec.io/path?q=1');
  assert.equal(normalizeTargetUrl('//example.com/a').href, 'https://example.com/a');
  assert.equal(normalizeTargetUrl('https://example.com').href, 'https://example.com/');
  assert.equal(normalizeTargetUrl('http://example.com').href, 'http://example.com/');
  assert.equal(normalizeTargetUrl('ftp://example.com').protocol, 'ftp:');
  assert.equal(normalizeTargetUrl('example.com:8080').href, 'https://example.com:8080/');
});

test('/?url= without scheme reaches the page renderer as https', async () => {
  const cache = memoryCache();
  const limiter = createMemoryLimiter();
  let seen;
  const renderPage = async href => { seen = href; return '# page'; };
  const response = await call('/?url=example.com', { cache, limiter, renderPage, resolveHost: allow });
  assert.equal(response.status, 200);
  assert.equal(seen, 'https://example.com/');
  assert.equal(await response.text(), '# page');
});

test('/?url= ftp, localhost, and loopback stay rejected', async () => {
  const cache = memoryCache();
  const limiter = createMemoryLimiter();
  let rendered = 0;
  const renderPage = async () => { rendered += 1; return 'nope'; };
  for (const path of ['/?url=ftp://example.com', '/?url=localhost', '/?url=127.0.0.1']) {
    const response = await call(path, { cache, limiter, renderPage, resolveHost: allow });
    assert.equal(response.status, 400, path);
    assert.equal(await response.text(), 'Blocked target\n', path);
  }
  assert.equal(rendered, 0);
});
