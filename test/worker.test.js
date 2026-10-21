import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, createMemoryLimiter } from '../src/worker.js';
import { NotFoundError, NetworkError } from '../src/fetch.js';

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

test('GET /health returns 200 ok and is not cached', async () => {
  const cache = memoryCache();
  const response = await call('/health', { cache, render: async () => assert.fail('health must not render') });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
  assert.match(response.headers.get('content-type'), /text\/plain/);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('x-xmd-cache'), null);
});

test('/md post 200 MISS then HIT; renderer called once', async () => {
  const cache = memoryCache();
  let calls = 0;
  const render = async (id, mode) => { calls++; return `# ${mode}:${id}`; };
  const first = await call('/md?url=1', { cache, render });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-xmd-cache'), 'MISS');
  assert.match(first.headers.get('content-type'), /text\/markdown/);
  assert.equal(first.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(first.headers.get('x-xmd-engine'), 'x');
  assert.equal(await first.text(), '# post:1');
  const second = await call('/md?url=https://x.com/jack/status/1', { cache, render });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-xmd-cache'), 'HIT');
  assert.equal(second.headers.get('x-xmd-engine'), 'x');
  assert.equal(await second.text(), '# post:1');
  assert.equal(calls, 1);
});

test('/md/thread /md/ancestors /md/replies routes', async () => {
  const cache = memoryCache();
  const render = async (id, mode) => `${mode}:${id}`;
  for (const mode of ['thread', 'ancestors', 'replies']) {
    const response = await call(`/md/${mode}?url=7`, { cache, render });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), `${mode}:7`);
  }
});

test('invalid mode, bad url, unknown path, POST', async () => {
  const cache = memoryCache();
  const render = async () => 'markdown';
  const invalid = await call('/md?mode=ancestor&url=1', { cache, render });
  assert.equal(invalid.status, 400);
  assert.equal(await invalid.text(), 'Invalid mode\n');
  const bad = await call('/md?url=bad', { cache, render });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /./);
  const missing = await call('/other', { cache, render });
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), 'Not found\n');
  const post = await call('/md?url=1', { method: 'POST', cache, render });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET');
  assert.equal(await post.text(), 'Method not allowed\n');
});

test('NotFoundError -> 404 and NetworkError -> 502', async () => {
  const cache = memoryCache();
  const notFound = await call('/md?url=1', { cache, render: async () => { throw new NotFoundError('missing'); } });
  assert.equal(notFound.status, 404);
  assert.equal(await notFound.text(), 'missing\n');
  const network = await call('/md?url=2', { cache, render: async () => { throw new NetworkError('upstream'); } });
  assert.equal(network.status, 502);
  assert.equal(await network.text(), 'upstream\n');
});

test('memory limiter returns 429 after 30 misses; other IP still passes; hits are free', async () => {
  const cache = memoryCache();
  const render = async id => `body:${id}`;
  const ip = '203.0.113.10';
  for (let i = 1; i <= 30; i++) {
    const response = await call(`/md?url=${i}`, { ip, cache, render });
    assert.equal(response.status, 200, `miss ${i}`);
  }
  const hit = await call('/md?url=1', { ip, cache, render });
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get('x-xmd-cache'), 'HIT');
  const limited = await call('/md?url=31', { ip, cache, render });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(limited.headers.get('x-xmd-ratelimit'), 'memory');
  assert.equal(await limited.text(), 'Rate limit exceeded; try again in a minute\n');
  const other = await call('/md?url=32', { ip: '203.0.113.11', cache, render });
  assert.equal(other.status, 200);
});

test('RATE_LIMITER binding path sets x-xmd-ratelimit: binding while memory still allows', async () => {
  const cache = memoryCache();
  const limiter = createMemoryLimiter();
  const env = { RATE_LIMITER: { async limit({ key }) { assert.equal(key, '198.51.100.20'); return { success: false }; } } };
  const response = await call('/md?url=1', { ip: '198.51.100.20', env, cache, limiter, render: async () => 'markdown' });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('x-xmd-ratelimit'), 'binding');
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(await response.text(), 'Rate limit exceeded; try again in a minute\n');
});

test('RATE_LIMITER success:true does not block', async () => {
  const cache = memoryCache();
  const limiter = createMemoryLimiter();
  let bindingCalls = 0;
  const env = { RATE_LIMITER: { async limit({ key }) { bindingCalls++; assert.equal(key, '203.0.113.50'); return { success: true }; } } };
  const response = await call('/md?url=99', { ip: '203.0.113.50', env, cache, limiter, render: async () => 'ok' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
  assert.equal(bindingCalls, 1);
});

test('createMemoryLimiter factory: 30 then block, other key passes, window resets', async () => {
  let t = 0;
  const limiter = createMemoryLimiter({ limit: 30, periodMs: 60_000, now: () => t });
  for (let i = 0; i < 30; i++) assert.equal((await limiter.limit({ key: 'a' })).success, true);
  assert.equal((await limiter.limit({ key: 'a' })).success, false);
  assert.equal((await limiter.limit({ key: 'b' })).success, true);
  t = 60_000;
  assert.equal((await limiter.limit({ key: 'a' })).success, true);
});

const allowHost = async () => ['93.184.216.34'];

test('GET /?url= X post and /md set x-xmd-engine x; page HIT keeps engine', async () => {
  const cache = memoryCache();
  const limiter = createMemoryLimiter();
  const x = await call('/?url=https://x.com/jack/status/55', { cache, limiter, render: async () => '# xpost' });
  assert.equal(x.status, 200);
  assert.equal(x.headers.get('x-xmd-engine'), 'x');

  const html = `<html><head><title>Hello</title></head><body><p>${'word '.repeat(80)}</p></body></html>`;
  const fetchImpl = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  const env = {
    AI: {
      async toMarkdown(files, options) {
        assert.equal(files[0].name, 'page.html');
        assert.equal(files[0].blob.type, 'text/html');
        assert.equal(options.conversionOptions.html.hostname, 'https://example.com/cached');
        return [{ format: 'markdown', data: '# Hello\n\n' + 'x'.repeat(300) }];
      },
    },
  };
  const miss = await call('/?url=https://example.com/cached', { cache, limiter, env, fetchImpl, resolveHost: allowHost });
  assert.equal(miss.status, 200);
  assert.equal(miss.headers.get('x-xmd-cache'), 'MISS');
  assert.equal(miss.headers.get('x-xmd-engine'), 'ai');
  const hit = await call('/?url=https://example.com/cached', { cache, limiter, env, fetchImpl, resolveHost: allowHost });
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get('x-xmd-cache'), 'HIT');
  assert.equal(hit.headers.get('x-xmd-engine'), 'ai');
});

test('browser errors: quota, busy, failed; SSRF never calls AI or browserRender', async () => {
  const jsOnly = '<div id=root></div><noscript>You need to enable JavaScript to run this app.</noscript>';
  const fetchImpl = async () => new Response(jsOnly, { status: 200, headers: { 'content-type': 'text/html' } });
  const browserEnv = { BROWSER: {} };

  const quota = await call('/?url=https://example.com/quota', {
    cache: memoryCache(),
    limiter: createMemoryLimiter(),
    env: browserEnv,
    fetchImpl,
    resolveHost: allowHost,
    browserRender: async () => { throw new Error('429 Too Many Requests: browser time limit exceeded'); },
  });
  assert.equal(quota.status, 503);
  assert.equal(quota.headers.get('Retry-After'), '3600');
  assert.equal(quota.headers.get('x-xmd-engine'), 'browser');
  assert.equal(quota.headers.get('x-xmd-browser-error'), 'quota');
  assert.equal(await quota.text(), 'Browser rendering daily quota exhausted (Cloudflare free plan); try again tomorrow\n');

  const busy = await call('/?url=https://example.com/busy', {
    cache: memoryCache(),
    limiter: createMemoryLimiter(),
    env: browserEnv,
    fetchImpl,
    resolveHost: allowHost,
    browserRender: async () => { throw new Error('429 Too Many Requests: too many concurrent browsers'); },
  });
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('Retry-After'), '60');
  assert.equal(busy.headers.get('x-xmd-engine'), 'browser');
  assert.equal(busy.headers.get('x-xmd-browser-error'), 'busy');
  assert.equal(await busy.text(), 'Browser rendering is busy (free plan limits new/concurrent browsers); retry in a minute\n');

  const failedEmpty = await call('/?url=https://example.com/fail-empty', {
    cache: memoryCache(),
    limiter: createMemoryLimiter(),
    env: browserEnv,
    fetchImpl,
    resolveHost: allowHost,
    browserRender: async () => { throw new Error('Navigation timeout'); },
  });
  assert.equal(failedEmpty.status, 502);
  assert.equal(failedEmpty.headers.get('x-xmd-browser-error'), 'failed');
  assert.equal(await failedEmpty.text(), 'Browser rendering failed\n');

  const failedKeep = await call('/?url=https://example.com/fail-keep', {
    cache: memoryCache(),
    limiter: createMemoryLimiter(),
    env: {
      BROWSER: {},
      AI: { async toMarkdown() { return [{ format: 'markdown', data: '# Hello\n\n' + 'x'.repeat(300) }]; } },
    },
    fetchImpl,
    resolveHost: allowHost,
    browserRender: async () => { throw new Error('Navigation timeout'); },
  });
  assert.equal(failedKeep.status, 200);
  assert.equal(failedKeep.headers.get('x-xmd-engine'), 'ai');
  assert.equal(failedKeep.headers.get('x-xmd-browser-error'), 'failed');
  assert.match(await failedKeep.text(), /xxxxx/);

  let aiCalls = 0;
  let browseCalls = 0;
  const blocked = await call('/?url=http://127.0.0.1', {
    cache: memoryCache(),
    limiter: createMemoryLimiter(),
    env: {
      BROWSER: {},
      AI: { async toMarkdown() { aiCalls += 1; return [{ format: 'markdown', data: 'nope' }]; } },
    },
    browserRender: async () => { browseCalls += 1; return '<p>nope</p>'; },
  });
  assert.equal(blocked.status, 400);
  assert.equal(await blocked.text(), 'Blocked target\n');
  assert.equal(aiCalls, 0);
  assert.equal(browseCalls, 0);
});
