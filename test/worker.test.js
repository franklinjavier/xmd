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

async function call(path, { method = 'GET', ip, env = {}, browserLimiter, ...deps } = {}) {
  const pending = [];
  const ctx = { waitUntil(p) { pending.push(p); } };
  const headers = {};
  if (ip) headers['cf-connecting-ip'] = ip;
  const response = await handle(new Request(`https://xmd.test${path}`, { method, headers }), env, ctx, {
    render: async () => 'markdown',
    browserLimiter: browserLimiter ?? createMemoryLimiter({ limit: 1000 }),
    ...deps,
  });
  await Promise.all(pending);
  return response;
}

const TEXT_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";
function assertTextSecurity(response) {
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-security-policy'), TEXT_CSP);
}

test('GET /health returns 200 ok and is not cached', async () => {
  const cache = memoryCache();
  const response = await call('/health', { cache, render: async () => assert.fail('health must not render') });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
  assert.match(response.headers.get('content-type'), /text\/plain/);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('x-xmd-cache'), null);
  assertTextSecurity(response);
});

test('GET / landing HTML, /og.png, /extension.sh; /?url= stays markdown', async () => {
  const landing = await call('/', { render: async () => assert.fail('landing must not render') });
  assert.equal(landing.status, 200);
  assert.match(landing.headers.get('content-type'), /text\/html/);
  assert.equal(landing.headers.get('content-security-policy'), "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com");
  const html = await landing.text();
  assert.match(html, /og:image/);
  assert.match(html, /https:\/\/xmd\.imfrank\.dev\/og\.png/);

  const og = await call('/og.png', { render: async () => assert.fail('og must not render') });
  assert.equal(og.status, 200);
  assert.match(og.headers.get('content-type'), /image\/png/);
  const ogBytes = new Uint8Array(await og.arrayBuffer());
  assert.deepEqual([...ogBytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const sh = await call('/extension.sh', { render: async () => assert.fail('extension.sh must not render') });
  assert.equal(sh.status, 200);
  assert.match(sh.headers.get('content-type'), /text\/x-shellscript/);
  assert.ok((await sh.text()).startsWith('#!/bin/sh'));

  const allow = async () => ['93.184.216.34'];
  const page = await call('/?url=https://example.com', {
    cache: memoryCache(),
    limiter: createMemoryLimiter(),
    renderPage: async href => `# page:${href}`,
    resolveHost: allow,
  });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/markdown/);
  assert.equal(await page.text(), '# page:https://example.com/');
});

test('GET /favicon.ico and /apple-touch-icon.png skip limiter and AI', async () => {
  const env = {
    RATE_LIMITER: { async limit() { return { success: false }; } },
    AI: { run() { throw new Error('ai must not run'); } },
  };
  const ico = await call('/favicon.ico', { env, render: async () => assert.fail('icon must not render') });
  assert.equal(ico.status, 200);
  assert.match(ico.headers.get('content-type'), /^image\//);
  const icoBytes = new Uint8Array(await ico.arrayBuffer());
  assert.ok(icoBytes.byteLength > 0);
  assert.deepEqual([...icoBytes.subarray(0, 4)], [0x00, 0x00, 0x01, 0x00]);

  const png = await call('/apple-touch-icon.png', { env, render: async () => assert.fail('icon must not render') });
  assert.equal(png.status, 200);
  assert.match(png.headers.get('content-type'), /image\/png/);
  const pngBytes = new Uint8Array(await png.arrayBuffer());
  assert.deepEqual([...pngBytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
  assertTextSecurity(first);
  assert.equal(await first.text(), '# post:1');
  const second = await call('/md?url=https://x.com/jack/status/1', { cache, render });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-xmd-cache'), 'HIT');
  assert.equal(second.headers.get('x-xmd-engine'), 'x');
  assertTextSecurity(second);
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
  assertTextSecurity(invalid);
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
  assert.equal(x.headers.get('x-xmd-source'), 'x');

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
  assert.equal(miss.headers.get('x-xmd-source'), 'ai');
  const hit = await call('/?url=https://example.com/cached', { cache, limiter, env, fetchImpl, resolveHost: allowHost });
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get('x-xmd-cache'), 'HIT');
  assert.equal(hit.headers.get('x-xmd-engine'), 'ai');
  assert.equal(hit.headers.get('x-xmd-source'), 'ai');
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
  const retryAfter = Number(quota.headers.get('Retry-After'));
  assert.ok(retryAfter > 0 && retryAfter <= 86400);
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

test('rate-limited page request does not call resolveHost', async () => {
  const cache = memoryCache();
  const limiter = createMemoryLimiter({ limit: 1 });
  const first = await call('/?url=https://example.com/a', {
    ip: '203.0.113.9', cache, limiter,
    renderPage: async () => '# a',
    resolveHost: allowHost,
  });
  assert.equal(first.status, 200);
  let dns = 0;
  const limited = await call('/?url=https://example.com/b', {
    ip: '203.0.113.9', cache, limiter,
    renderPage: async () => '# b',
    resolveHost: async () => { dns += 1; return ['93.184.216.34']; },
  });
  assert.equal(limited.status, 429);
  assert.equal(dns, 0);
  assertTextSecurity(limited);
});

test('page cache key drops tracking params and fragments', async () => {
  const cache = memoryCache();
  const limiter = createMemoryLimiter();
  let n = 0;
  const renderPageFn = async href => { n += 1; return `# page:${href}`; };
  const first = await call('/?url=' + encodeURIComponent('https://example.com/p?utm_source=x&id=1#frag'), {
    cache, limiter, renderPage: renderPageFn, resolveHost: allowHost,
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-xmd-cache'), 'MISS');
  const second = await call('/?url=' + encodeURIComponent('https://example.com/p?id=1&fbclid=abc'), {
    cache, limiter, renderPage: renderPageFn, resolveHost: allowHost,
  });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-xmd-cache'), 'HIT');
  assert.equal(n, 1);
  const third = await call('/?url=' + encodeURIComponent('https://example.com/p?id=2'), {
    cache, limiter, renderPage: renderPageFn, resolveHost: allowHost,
  });
  assert.equal(third.headers.get('x-xmd-cache'), 'MISS');
  assert.equal(n, 2);
});

test('browser budget denies without launching; fallback or 429', async () => {
  const jsOnly = '<div id=root></div><noscript>You need to enable JavaScript to run this app.</noscript>';
  const fetchImpl = async () => new Response(jsOnly, { status: 200, headers: { 'content-type': 'text/html' } });
  let browseCalls = 0;
  const browserRender = async () => { browseCalls += 1; return '<p>nope</p>'; };

  const empty = await call('/?url=https://example.com/budget-empty', {
    ip: '198.51.100.10',
    cache: memoryCache(),
    limiter: createMemoryLimiter(),
    browserLimiter: createMemoryLimiter({ limit: 0 }),
    env: { BROWSER: {} },
    fetchImpl,
    resolveHost: allowHost,
    browserRender,
  });
  assert.equal(empty.status, 429);
  assert.equal(empty.headers.get('retry-after'), '60');
  assert.equal(empty.headers.get('x-xmd-browser-error'), 'budget');
  assert.equal(await empty.text(), 'Browser rendering budget exceeded; try again later\n');
  assert.equal(browseCalls, 0);
  assertTextSecurity(empty);

  const keep = await call('/?url=https://example.com/budget-keep', {
    ip: '198.51.100.11',
    cache: memoryCache(),
    limiter: createMemoryLimiter(),
    browserLimiter: createMemoryLimiter({ limit: 0 }),
    env: {
      BROWSER: {},
      AI: { async toMarkdown() { return [{ format: 'markdown', data: '# Hello\n\n' + 'x'.repeat(300) }]; } },
    },
    fetchImpl,
    resolveHost: allowHost,
    browserRender,
  });
  assert.equal(keep.status, 200);
  assert.equal(keep.headers.get('x-xmd-engine'), 'ai');
  assert.equal(keep.headers.get('x-xmd-browser-error'), 'budget');
  assert.equal(browseCalls, 0);
});

test('browser daily cap and quota flag skip the browser', async () => {
  const jsOnly = '<div id=root></div><noscript>You need to enable JavaScript to run this app.</noscript>';
  const fetchImpl = async () => new Response(jsOnly, { status: 200, headers: { 'content-type': 'text/html' } });
  const date = new Date().toISOString().slice(0, 10);
  const cache = memoryCache();
  await cache.put(
    new Request(`https://xmd-cache.internal/browser-budget/${date}`, { method: 'GET' }),
    new Response('40', { headers: { 'Cache-Control': 'max-age=172800' } }),
  );
  let browseCalls = 0;
  const capped = await call('/?url=https://example.com/daily-cap', {
    cache,
    limiter: createMemoryLimiter(),
    env: { BROWSER: {} },
    fetchImpl,
    resolveHost: allowHost,
    browserRender: async () => { browseCalls += 1; return '<p>nope</p>'; },
  });
  assert.equal(capped.status, 503);
  assert.equal(capped.headers.get('x-xmd-browser-error'), 'quota');
  const ra = Number(capped.headers.get('Retry-After'));
  assert.ok(ra > 0 && ra <= 86400);
  assert.equal(browseCalls, 0);

  const cache2 = memoryCache();
  await cache2.put(
    new Request(`https://xmd-cache.internal/browser-quota/${date}`, { method: 'GET' }),
    new Response('1', { headers: { 'Cache-Control': 'max-age=172800' } }),
  );
  const flagged = await call('/?url=https://example.com/quota-flag', {
    cache: cache2,
    limiter: createMemoryLimiter(),
    env: { BROWSER: {} },
    fetchImpl,
    resolveHost: allowHost,
    browserRender: async () => { browseCalls += 1; return '<p>nope</p>'; },
  });
  assert.equal(flagged.status, 503);
  assert.equal(flagged.headers.get('x-xmd-browser-error'), 'quota');
  assert.equal(browseCalls, 0);
});

test('BROWSER_LIMITER and BROWSER_GLOBAL_LIMITER bindings deny budget', async () => {
  const jsOnly = '<div id=root></div><noscript>You need to enable JavaScript to run this app.</noscript>';
  const fetchImpl = async () => new Response(jsOnly, { status: 200, headers: { 'content-type': 'text/html' } });
  let browseCalls = 0;
  const perIp = await call('/?url=https://example.com/bl', {
    ip: '198.51.100.40',
    cache: memoryCache(),
    limiter: createMemoryLimiter(),
    env: { BROWSER: {}, BROWSER_LIMITER: { async limit({ key }) { assert.equal(key, '198.51.100.40'); return { success: false }; } } },
    fetchImpl,
    resolveHost: allowHost,
    browserRender: async () => { browseCalls += 1; return '<p>nope</p>'; },
  });
  assert.equal(perIp.status, 429);
  assert.equal(perIp.headers.get('x-xmd-browser-error'), 'budget');
  assert.equal(browseCalls, 0);

  const global = await call('/?url=https://example.com/bg', {
    ip: '198.51.100.41',
    cache: memoryCache(),
    limiter: createMemoryLimiter(),
    env: { BROWSER: {}, BROWSER_GLOBAL_LIMITER: { async limit({ key }) { assert.equal(key, 'global'); return { success: false }; } } },
    fetchImpl,
    resolveHost: allowHost,
    browserRender: async () => { browseCalls += 1; return '<p>nope</p>'; },
  });
  assert.equal(global.status, 429);
  assert.equal(global.headers.get('x-xmd-browser-error'), 'budget');
  assert.equal(browseCalls, 0);
});

test('in-flight browser jobs with the same cache key share one render', async () => {
  const jsOnly = '<div id=root></div><noscript>You need to enable JavaScript to run this app.</noscript>';
  const fetchImpl = async () => new Response(jsOnly, { status: 200, headers: { 'content-type': 'text/html' } });
  const rich = `<html><head><title>Rendered</title></head><body><article><p>${'content '.repeat(80)}</p></article></body></html>`;
  let browseCalls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const cache = memoryCache();
  const limiter = createMemoryLimiter();
  const env = { BROWSER: {} };
  const browserRender = async () => {
    browseCalls += 1;
    await gate;
    return rich;
  };
  const p1 = call('/?url=https://example.com/dedupe', { cache, limiter, env, fetchImpl, resolveHost: allowHost, browserRender });
  const p2 = call('/?url=https://example.com/dedupe', { cache, limiter, env, fetchImpl, resolveHost: allowHost, browserRender });
  for (let i = 0; i < 50 && browseCalls === 0; i++) await new Promise(r => setTimeout(r, 10));
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(browseCalls, 1);
});
