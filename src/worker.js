import { parseUrl } from './parse-url.js';
import { render as defaultRender, modes } from './modes.js';
import { NotFoundError, NetworkError } from './fetch.js';
import { VERSION } from './version.js';
import {
  fetchPage, htmlToMarkdown, extractTitle, looksJsOnly, visibleText, wrapPage,
  validateTarget, normalizeTargetUrl, USAGE, UnsupportedTypeError,
} from './page.js';

const DEADLINE_MS = 45_000;
const CACHE_MAX_AGE = 300;
const CACHE_CONTROL = `public, max-age=${CACHE_MAX_AGE}`;
const CACHE_VERSION = `v${VERSION.split('.').slice(0, 2).join('.')}`;
const PAGE_CACHE_VERSION = 'v0.3.1';

let defaultLimiter;

export class BrowserQuotaError extends Error {
  constructor(message = 'Browser rendering daily quota exhausted (Cloudflare free plan); try again tomorrow') {
    super(message);
    this.name = 'BrowserQuotaError';
  }
}

export class BrowserBusyError extends Error {
  constructor(message = 'Browser rendering is busy (free plan limits new/concurrent browsers); retry in a minute') {
    super(message);
    this.name = 'BrowserBusyError';
  }
}

export function createMemoryLimiter({ limit = 30, periodMs = 60_000, maxKeys = 10_000, now = Date.now } = {}) {
  const windows = new Map();
  return {
    async limit({ key }) {
      const t = now();
      for (const [k, entry] of windows) {
        if (t - entry.start >= periodMs) windows.delete(k);
      }
      let entry = windows.get(key);
      if (!entry || t - entry.start >= periodMs) {
        if (!entry && windows.size >= maxKeys) windows.delete(windows.keys().next().value);
        entry = { start: t, count: 0 };
        windows.set(key, entry);
      }
      if (entry.count >= limit) return { success: false };
      entry.count += 1;
      return { success: true };
    },
  };
}

function reply(status, body, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      ...headers,
    },
  });
}

function errorResponse(error) {
  if (error.name === 'BrowserQuotaError' || error instanceof BrowserQuotaError) {
    return reply(503, `${error.message}\n`, {
      'Retry-After': '3600',
      'x-xmd-engine': 'browser',
      'x-xmd-browser-error': 'quota',
    });
  }
  if (error.name === 'BrowserBusyError' || error instanceof BrowserBusyError) {
    return reply(503, `${error.message}\n`, {
      'Retry-After': '60',
      'x-xmd-engine': 'browser',
      'x-xmd-browser-error': 'busy',
    });
  }
  const status = error.name === 'TimeoutError' ? 504
    : error instanceof UnsupportedTypeError ? 415
    : error instanceof NotFoundError ? 404
    : error instanceof NetworkError ? 502
    : 400;
  const headers = {};
  if (error.browserError) headers['x-xmd-browser-error'] = error.browserError;
  return reply(status, `${error.message}\n`, headers);
}

function cacheKey(mode, id) {
  return new Request(`https://xmd-cache.internal/${CACHE_VERSION}/${mode}/${id}`, { method: 'GET' });
}

async function pageCacheKey(href) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(href));
  const hex = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  return new Request(`https://xmd-cache.internal/${PAGE_CACHE_VERSION}/page/${hex}`, { method: 'GET' });
}

async function enforceLimit(request, env, deps) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const memoryLimiter = deps.limiter ?? (defaultLimiter ??= createMemoryLimiter({ now: deps.now ?? Date.now }));
  const memoryAllowed = await memoryLimiter.limit({ key: ip });
  if (!memoryAllowed?.success) {
    return reply(429, 'Rate limit exceeded; try again in a minute\n', {
      'Retry-After': '60',
      'x-xmd-ratelimit': 'memory',
    });
  }
  if (typeof env?.RATE_LIMITER?.limit === 'function') {
    const bindingAllowed = await env.RATE_LIMITER.limit({ key: ip });
    if (!bindingAllowed?.success) {
      return reply(429, 'Rate limit exceeded; try again in a minute\n', {
        'Retry-After': '60',
        'x-xmd-ratelimit': 'binding',
      });
    }
  }
  return null;
}

async function tryAiMarkdown(env, html, finalUrl) {
  if (typeof env?.AI?.toMarkdown !== 'function') return null;
  try {
    const result = await env.AI.toMarkdown(
      [{ name: 'page.html', blob: new Blob([html], { type: 'text/html' }) }],
      { conversionOptions: { html: { hostname: finalUrl } } },
    );
    const first = Array.isArray(result) ? result[0] : result;
    if (first?.format === 'markdown' && String(first.data || '').trim()) return String(first.data);
    return null;
  } catch {
    return null;
  }
}

export async function convertWebPage(input, env, deps, { signal, selfHost } = {}) {
  const page = await fetchPage(input, {
    signal,
    fetchImpl: deps.fetchImpl,
    resolveHost: deps.resolveHost,
    selfHost,
  });
  if (page.media === 'text/plain' || page.media === 'text/markdown') {
    return { body: wrapPage(page.title, page.finalUrl, page.body), engine: 'fallback' };
  }
  let markdown = await tryAiMarkdown(env, page.body, page.finalUrl);
  let engine = markdown ? 'ai' : 'fallback';
  if (!markdown) markdown = htmlToMarkdown(page.body, page.finalUrl);
  let title = page.title;
  const canBrowse = typeof deps.browserRender === 'function' && env?.BROWSER;
  if (canBrowse && looksJsOnly(page.body, markdown)) {
    try {
      const renderedHtml = String(await deps.browserRender(page.finalUrl, {
        signal,
        validate: url => validateTarget(url, { selfHost, resolveHost: deps.resolveHost }),
      }) ?? '');
      let renderedMd = await tryAiMarkdown(env, renderedHtml, page.finalUrl);
      if (!renderedMd) renderedMd = htmlToMarkdown(renderedHtml, page.finalUrl);
      if (visibleText(renderedMd).length > visibleText(markdown).length) {
        markdown = renderedMd;
        title = extractTitle(renderedHtml, title) || title;
        engine = 'browser';
      }
    } catch (error) {
      console.error('xmd browser error', error?.name, String(error?.message || error).slice(0, 500));
      const msg = String(error?.message || error);
      if (/daily|time limit|quota|browser time/i.test(msg)) throw new BrowserQuotaError();
      if (/429|rate limit|too many|concurrent|limit/i.test(msg)) throw new BrowserBusyError();
      if (!visibleText(markdown)) {
        const failed = new NetworkError('Browser rendering failed');
        failed.browserError = 'failed';
        throw failed;
      }
      return { body: wrapPage(title, page.finalUrl, markdown), engine, browserError: 'failed' };
    }
  }
  return { body: wrapPage(title, page.finalUrl, markdown), engine };
}

async function serveRendered(request, env, ctx, deps, cache, key, work, defaultEngine) {
  const waitUntil = typeof ctx?.waitUntil === 'function' ? ctx.waitUntil.bind(ctx) : () => {};
  const deadlineMs = deps.deadlineMs ?? DEADLINE_MS;
  const cached = cache ? await cache.match(key) : undefined;
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('x-xmd-cache', 'HIT');
    return new Response(cached.body, { status: cached.status, headers });
  }
  const limited = await enforceLimit(request, env, deps);
  if (limited) return limited;
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Render deadline exceeded');
      error.name = 'TimeoutError';
      controller.abort(error);
      reject(error);
    }, deadlineMs);
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => work(controller.signal)), timeout]);
    const body = result && typeof result === 'object' && 'body' in result ? result.body : result;
    const engine = result && typeof result === 'object' && result.engine ? result.engine : defaultEngine;
    const headers = {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': CACHE_CONTROL,
      'Access-Control-Allow-Origin': '*',
      'x-xmd-cache': 'MISS',
      'x-xmd-engine': engine,
    };
    if (result && typeof result === 'object' && result.browserError) {
      headers['x-xmd-browser-error'] = result.browserError;
    }
    const response = new Response(body, { status: 200, headers });
    if (cache) {
      const stored = response.clone();
      stored.headers.set('Cache-Control', CACHE_CONTROL);
      waitUntil(cache.put(key, stored));
    }
    return response;
  } catch (error) {
    return errorResponse(error);
  } finally {
    clearTimeout(timer);
  }
}

export async function handle(request, env = {}, ctx = {}, deps = {}) {
  const renderer = deps.render ?? defaultRender;
  const cache = deps.cache ?? globalThis.caches?.default ?? null;

  if (request.method !== 'GET') return reply(405, 'Method not allowed\n', { Allow: 'GET' });

  const url = new URL(request.url);
  const path = url.pathname.replace(/[\x00-\x1f\x7f]/g, '');
  if (path === '/health') return reply(200, 'ok');

  async function servePost(id, mode) {
    return serveRendered(request, env, ctx, deps, cache, cacheKey(mode, id), signal => renderer(id, mode, undefined, { signal }), 'x');
  }

  if (path === '/') {
    const raw = url.searchParams.get('url');
    if (raw === null) return reply(200, USAGE);
    if (!String(raw).trim()) return reply(400, 'Expected a URL\n');
    try {
      const { id } = parseUrl(raw);
      const mode = url.searchParams.get('mode') || 'post';
      if (!modes.includes(mode)) return reply(400, 'Invalid mode\n');
      return servePost(id, mode);
    } catch {
      // Not an X post; treat as a web page.
    }
    let target;
    try { target = normalizeTargetUrl(raw); }
    catch (error) { return reply(400, `${error.message}\n`); }
    try {
      await validateTarget(target.href, { selfHost: url.hostname, resolveHost: deps.resolveHost });
    } catch (error) {
      return errorResponse(error);
    }
    const key = await pageCacheKey(target.href);
    if (typeof deps.renderPage === 'function') {
      return serveRendered(request, env, ctx, deps, cache, key, signal => deps.renderPage(target.href, {
        signal,
        resolveHost: deps.resolveHost,
        selfHost: url.hostname,
        fetchImpl: deps.fetchImpl,
      }), 'fallback');
    }
    return serveRendered(request, env, ctx, deps, cache, key, signal => convertWebPage(target.href, env, deps, {
      signal,
      selfHost: url.hostname,
    }));
  }

  if (path !== '/md' && !/^\/md\/[^/]+$/.test(path)) return reply(404, 'Not found\n');

  const mode = path === '/md' ? url.searchParams.get('mode') || 'post' : path.slice(4);
  if (!modes.includes(mode)) return reply(400, 'Invalid mode\n');
  let id;
  try {
    id = parseUrl(url.searchParams.get('url')).id;
  } catch (error) {
    return reply(400, `${error.message}\n`);
  }
  return servePost(id, mode);
}
