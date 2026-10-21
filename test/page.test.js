import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTarget, htmlToMarkdown, renderPage, looksJsOnly, isBlockedHostSync, BlockedTargetError, UnsupportedTypeError, USAGE, neutralizeMarkdown, stripHiddenElements, canonicalizePageUrl } from '../src/page.js';
import { NetworkError } from '../src/fetch.js';
import { handle, createMemoryLimiter } from '../src/worker.js';

const allow = async () => ['93.184.216.34'];

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

async function call(path, deps = {}) {
  const pending = [];
  const ctx = { waitUntil(p) { pending.push(p); } };
  const { env = {}, method = 'GET', ip, browserLimiter, ...rest } = deps;
  const headers = {};
  if (ip) headers['cf-connecting-ip'] = ip;
  const response = await handle(new Request(`https://xmd.test${path}`, { method, headers }), env, ctx, {
    browserLimiter: browserLimiter ?? createMemoryLimiter({ limit: 1000 }),
    ...rest,
  });
  await Promise.all(pending);
  return response;
}

test('validateTarget blocks private, special, and malformed targets', async () => {
  const blocked = [
    'http://127.0.0.1',
    'http://localhost',
    'http://2130706433',
    'http://0x7f.1',
    'http://0177.0.0.1',
    'http://[::1]',
    'http://[::ffff:127.0.0.1]',
    'http://[::ffff:7f00:1]',
    'http://[::127.0.0.1]/',
    'http://[2002:7f00:1::]/',
    'http://[64:ff9b:1::7f00:1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[2001:db8::1]/',
    'http://[2001::1]/',
    'http://[fec0::1]/',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1',
    'http://100.64.0.1',
    'http://192.168.1.1',
    'http://[fd00::1]',
    'http://example.com:8080',
    'file:///etc/passwd',
    'ftp://example.com',
    'http://user:pass@example.com',
    'http://intranet',
    'http://foo.internal',
    'http://abc.workers.dev',
  ];
  for (const url of blocked) {
    await assert.rejects(() => validateTarget(url, { resolveHost: async () => assert.fail(`dns for ${url}`) }), error => {
      assert.ok(error instanceof BlockedTargetError, url);
      assert.equal(error.message, 'Blocked target', url);
      return true;
    });
  }
  await assert.rejects(() => validateTarget('https://evil.example/', { selfHost: 'evil.example', resolveHost: allow }), BlockedTargetError);
  await assert.rejects(() => validateTarget('https://xmd.imfrank.dev/', { resolveHost: allow }), BlockedTargetError);
  await validateTarget('https://example.com/', { resolveHost: allow });
  await validateTarget('http://example.org', { resolveHost: allow });
  await validateTarget('http://[2606:4700:4700::1111]/', { resolveHost: async () => assert.fail('literal global IPv6 must skip DNS') });
});

test('validateTarget DNS: blocked address, empty, allowed', async () => {
  await assert.rejects(() => validateTarget('https://example.com/', { resolveHost: async () => ['10.0.0.5'] }), BlockedTargetError);
  await assert.rejects(() => validateTarget('https://example.com/', { resolveHost: async () => [] }), error => {
    assert.ok(error instanceof NetworkError);
    assert.equal(error.message, 'Could not resolve host');
    return true;
  });
  await validateTarget('https://example.com/', { resolveHost: async () => ['93.184.216.34'] });
});

test('renderPage follows relative redirects and blocks private hops', async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'manual');
    assert.equal(options.method, 'GET');
    if (url === 'https://example.com/start') return new Response('', { status: 302, headers: { Location: '/next' } });
    if (url === 'https://example.com/next') {
      return new Response('<html><head><meta property="og:title" content="OG Title"><title>T</title></head><body><p>Hi</p></body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    throw new Error(`unexpected ${url}`);
  };
  const md = await renderPage('https://example.com/start', { fetchImpl, resolveHost: allow });
  assert.match(md, /^# OG Title/m);
  assert.match(md, /Source: https:\/\/example.com\/next/);
  assert.match(md, /Hi/);

  await assert.rejects(
    () => renderPage('https://example.com/to-loopback', {
      resolveHost: allow,
      fetchImpl: async () => new Response('', { status: 302, headers: { Location: 'http://127.0.0.1/' } }),
    }),
    BlockedTargetError,
  );
});

test('renderPage too many redirects is 502', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return new Response('', { status: 302, headers: { Location: `https://example.com/h${n}` } });
  };
  await assert.rejects(() => renderPage('https://example.com/r', { fetchImpl, resolveHost: allow }), error => {
    assert.ok(error instanceof NetworkError);
    assert.equal(error.message, 'Too many redirects');
    return true;
  });
  assert.equal(n, 6);
});

test('renderPage content types, plain text, and 2 MB cap', async () => {
  await assert.rejects(
    () => renderPage('https://example.com/img', {
      resolveHost: allow,
      fetchImpl: async () => new Response('x', { status: 200, headers: { 'content-type': 'image/png' } }),
    }),
    UnsupportedTypeError,
  );
  const plain = await renderPage('https://example.com/note', {
    resolveHost: allow,
    fetchImpl: async () => new Response('hello plain', { status: 200, headers: { 'content-type': 'text/plain' } }),
  });
  assert.match(plain, /^# example.com/m);
  assert.match(plain, /Source: https:\/\/example.com\/note/);
  assert.match(plain, /hello plain/);
  await assert.rejects(
    () => renderPage('https://example.com/big', {
      resolveHost: allow,
      fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200, headers: { 'content-type': 'text/plain' } }),
    }),
    /exceeds 2 MB/,
  );
});

test('htmlToMarkdown: headings, links, lists, code, entities, drop, article, og:title', async () => {
  const html = `<!doctype html><html><head>
<meta property="og:title" content="OG Title">
<title>Page Title</title>
</head><body>
<nav>Skip nav</nav>
<script>alert(1)</script>
<main><h1>Main heading</h1></main>
<article>
<h1>Hello</h1>
<p>See <a href="/rel">link</a> and <a href="javascript:alert(1)">js</a>.</p>
<ul><li>one</li><li>two</li></ul>
<pre>code
block</pre>
<p>A &amp; B &mdash; ok</p>
</article>
</body></html>`;
  const md = htmlToMarkdown(html, 'https://example.com/page');
  assert.match(md, /^# Hello/m);
  assert.doesNotMatch(md, /Main heading|Skip nav|alert\(1\)/);
  assert.match(md, /\[link\]\(https:\/\/example.com\/rel\)/);
  assert.match(md, /js/);
  assert.doesNotMatch(md, /javascript:/);
  assert.match(md, /^- one/m);
  assert.match(md, /```[\s\S]*code\nblock/);
  assert.match(md, /A & B — ok/);
  const page = await renderPage('https://example.com/page', {
    resolveHost: allow,
    fetchImpl: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  assert.match(page, /^# OG Title/m);
});

test('Worker GET / usage, X post, page cache, blocked loopback', async () => {
  const cache = memoryCache();
  const limiter = createMemoryLimiter();
  const usage = await call('/', { cache, limiter, render: async () => assert.fail('usage must not render') });
  assert.equal(usage.status, 200);
  assert.match(usage.headers.get('content-type'), /text\/html/);
  assert.match(await usage.text(), /og:image/);
  assert.match(USAGE, /GET \/\?url=/);

  const empty = await call('/?url=', { cache, limiter });
  assert.equal(empty.status, 400);

  let postCalls = 0;
  const render = async (id, mode) => { postCalls += 1; return `# ${mode}:${id}`; };
  const post = await call('/?url=https://x.com/jack/status/123', { cache, limiter, render });
  assert.equal(post.status, 200);
  assert.equal(post.headers.get('x-xmd-engine'), 'x');
  assert.equal(await post.text(), '# post:123');
  assert.equal(postCalls, 1);

  let pageCalls = 0;
  const renderPageFn = async input => { pageCalls += 1; return `# page:${input}`; };
  const first = await call('/?url=https://example.com', { cache, limiter, render, renderPage: renderPageFn, resolveHost: allow });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-xmd-cache'), 'MISS');
  assert.equal(first.headers.get('x-xmd-engine'), 'fallback');
  assert.equal(await first.text(), '# page:https://example.com/');
  const second = await call('/?url=https://example.com/', { cache, limiter, render, renderPage: renderPageFn, resolveHost: allow });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-xmd-cache'), 'HIT');
  assert.equal(second.headers.get('x-xmd-engine'), 'fallback');
  assert.equal(pageCalls, 1);

  let forbidden = 0;
  const blocked = await call('/?url=http://127.0.0.1', {
    cache, limiter, render,
    renderPage: async () => { forbidden += 1; return 'nope'; },
  });
  assert.equal(blocked.status, 400);
  assert.equal(await blocked.text(), 'Blocked target\n');
  assert.equal(forbidden, 0);
});

test('looksJsOnly: example.com-like, SPA mount, noscript, long article', () => {
  const example = `<!doctype html><html><head><title>Example Domain</title></head><body>
<h1>Example Domain</h1>
<p>This domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.</p>
</body></html>`;
  assert.equal(looksJsOnly(example, 'short'), false);
  assert.equal(looksJsOnly('<div id=root></div><script src=/app.js></script>', ''), true);
  assert.equal(looksJsOnly('<div id=root></div><noscript>You need to enable JavaScript to run this app.</noscript>', 'x'.repeat(300)), true);
  const article = `<article><h1>Title</h1><p>${'word '.repeat(80)}</p></article><script src=/a.js></script><script>console.log(1)</script>`;
  assert.equal(looksJsOnly(article, 'x'.repeat(300)), false);
  assert.equal(looksJsOnly(`<p>${'word '.repeat(80)}</p><p>Please enable JavaScript.</p>`, 'x'.repeat(300)), true);
  assert.equal(looksJsOnly(`<p>${'word '.repeat(80)}</p><p>JavaScript is required.</p>`, 'x'.repeat(300)), true);
});

test('isBlockedHostSync blocks loopback/link-local and allows example.com', () => {
  for (const host of ['127.0.0.1', 'http://127.0.0.1/', 'localhost', 'http://localhost', '169.254.169.254', 'http://169.254.169.254/latest/meta-data', '[::1]', 'http://[::1]/']) {
    assert.equal(isBlockedHostSync(host), true, host);
  }
  assert.equal(isBlockedHostSync('example.com'), false);
  assert.equal(isBlockedHostSync('https://example.com/path'), false);
});

test('Worker AI toMarkdown success, throw, and format error', async () => {
  const html = `<html><head><title>Hello</title></head><body><p>${'word '.repeat(80)}</p></body></html>`;
  const fetchImpl = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  const limiter = createMemoryLimiter();
  const cache = memoryCache();
  let aiCalls = [];
  const env = {
    AI: {
      async toMarkdown(files, options) {
        aiCalls.push({ files, options });
        return [{ format: 'markdown', data: '# Hello\n\n' + 'x'.repeat(300) }];
      },
    },
  };
  const ok = await call('/?url=https://example.com/hello', { cache, limiter, env, fetchImpl, resolveHost: allow });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('x-xmd-engine'), 'ai');
  assert.equal(aiCalls.length, 1);
  assert.equal(aiCalls[0].files[0].name, 'page.html');
  assert.equal(aiCalls[0].files[0].blob.type, 'text/html');
  assert.equal(aiCalls[0].options.conversionOptions.html.hostname, 'https://example.com/hello');
  assert.match(await ok.text(), /xxxxx/);

  const throwEnv = { AI: { async toMarkdown() { throw new Error('ai down'); } } };
  const threw = await call('/?url=https://example.com/throw', {
    cache: memoryCache(), limiter: createMemoryLimiter(), env: throwEnv, fetchImpl, resolveHost: allow,
  });
  assert.equal(threw.status, 200);
  assert.equal(threw.headers.get('x-xmd-engine'), 'fallback');
  assert.match(await threw.text(), /word/);

  const errEnv = { AI: { async toMarkdown() { return [{ format: 'error', data: 'nope' }]; } } };
  const formatted = await call('/?url=https://example.com/err', {
    cache: memoryCache(), limiter: createMemoryLimiter(), env: errEnv, fetchImpl, resolveHost: allow,
  });
  assert.equal(formatted.status, 200);
  assert.equal(formatted.headers.get('x-xmd-engine'), 'fallback');
});

test('Worker JS-only page uses browserRender; omitted browserRender keeps ai', async () => {
  const jsOnly = '<div id=root></div><noscript>You need to enable JavaScript to run this app.</noscript>';
  const rich = `<html><head><title>Rendered</title></head><body><article><p>${'content '.repeat(80)}</p></article></body></html>`;
  const fetchImpl = async () => new Response(jsOnly, { status: 200, headers: { 'content-type': 'text/html' } });
  let browseCalls = 0;
  const browserRender = async url => {
    browseCalls += 1;
    assert.equal(url, 'https://example.com/app');
    return rich;
  };
  const browsed = await call('/?url=https://example.com/app', {
    cache: memoryCache(),
    limiter: createMemoryLimiter(),
    env: { BROWSER: {} },
    fetchImpl,
    resolveHost: allow,
    browserRender,
  });
  assert.equal(browsed.status, 200);
  assert.equal(browsed.headers.get('x-xmd-engine'), 'browser');
  assert.equal(browseCalls, 1);
  const body = await browsed.text();
  assert.match(body, /^# Rendered/m);
  assert.match(body, /content content/);

  let aiCalls = 0;
  const aiOnly = await call('/?url=https://example.com/spa', {
    cache: memoryCache(),
    limiter: createMemoryLimiter(),
    env: {
      AI: {
        async toMarkdown() {
          aiCalls += 1;
          return [{ format: 'markdown', data: '# Hello\n\n' + 'x'.repeat(300) }];
        },
      },
    },
    fetchImpl,
    resolveHost: allow,
  });
  assert.equal(aiOnly.status, 200);
  assert.equal(aiOnly.headers.get('x-xmd-engine'), 'ai');
  assert.equal(aiCalls, 1);
});

test('neutralizeMarkdown escapes tags and unsafe link schemes; fences keep tags', () => {
  assert.match(neutralizeMarkdown('hello <img src=x onerror=alert(1)>'), /&lt;img src=x onerror=alert\(1\)>/);
  assert.doesNotMatch(neutralizeMarkdown('hello <img src=x onerror=alert(1)>'), /<img/);
  const fenced = '```\n<div>\n```';
  assert.equal(neutralizeMarkdown(fenced), fenced);
  const tildes = '~~~\n<div>\n~~~';
  assert.equal(neutralizeMarkdown(tildes), tildes);
  assert.equal(neutralizeMarkdown('see `[x](javascript:alert(1))` in code'), 'see `[x](javascript:alert(1))` in code');
  assert.equal(neutralizeMarkdown('[x](javascript:alert(1))'), '[x](#)');
  assert.equal(neutralizeMarkdown('[x](data:text/html,hi)'), '[x](#)');
  assert.equal(neutralizeMarkdown('[x](vbscript:msg)'), '[x](#)');
  assert.equal(neutralizeMarkdown('[ok](https://example.com/a)'), '[ok](https://example.com/a)');
  assert.equal(neutralizeMarkdown('[mail](mailto:a@b.com)'), '[mail](mailto:a@b.com)');
  assert.equal(neutralizeMarkdown('<sub>❤️ 1</sub>'), '<sub>❤️ 1</sub>');
  assert.equal(neutralizeMarkdown('<sub onclick="x">'), '&lt;sub onclick="x">');
});

test('stripHiddenElements drops hidden, aria-hidden, and display:none', () => {
  const html = '<p>visible</p><p style="display:none">secret</p><div aria-hidden="true">ghost</div><span hidden>nope</span><img hidden src=x><p style="visibility:hidden">invis</p>';
  const out = stripHiddenElements(html);
  assert.match(out, /visible/);
  assert.doesNotMatch(out, /secret|ghost|nope|invis/);
  const nested = '<div hidden><div>inner</div><div>more</div></div>after';
  assert.equal(stripHiddenElements(nested), 'after');
});

test('htmlToMarkdown drops hidden text and wrapPage neutralizes raw tags', async () => {
  const html = `<html><body><p>&lt;img src=x onerror=alert(1)&gt;</p><p style="display:none">IGNORE PREVIOUS</p><div aria-hidden="true">hidden aria</div></body></html>`;
  const md = htmlToMarkdown(html, 'https://example.com/');
  assert.doesNotMatch(md, /IGNORE PREVIOUS|hidden aria/);
  const page = await renderPage('https://example.com/xss', {
    resolveHost: allow,
    fetchImpl: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  assert.match(page, /&lt;img src=x onerror=alert\(1\)>/);
  assert.doesNotMatch(page, /<img/);
  assert.doesNotMatch(page, /IGNORE PREVIOUS/);
});

test('Worker blocked IPv6 transition addresses are 400; global unicast passes literal check', async () => {
  const cache = memoryCache();
  const limiter = createMemoryLimiter();
  for (const href of ['http://[::127.0.0.1]/', 'http://[2002:7f00:1::]/', 'http://[64:ff9b:1::7f00:1]/', 'http://[64:ff9b::7f00:1]/']) {
    let forbidden = 0;
    const blocked = await call('/?url=' + encodeURIComponent(href), {
      cache, limiter,
      renderPage: async () => { forbidden += 1; return 'nope'; },
    });
    assert.equal(blocked.status, 400, href);
    assert.equal(await blocked.text(), 'Blocked target\n', href);
    assert.equal(forbidden, 0, href);
  }
  assert.equal(isBlockedHostSync('http://[2606:4700:4700::1111]/'), false);
  assert.equal(canonicalizePageUrl('https://example.com/a?utm_campaign=x&keep=1#hash'), 'https://example.com/a?keep=1');
});
