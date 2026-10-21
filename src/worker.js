import { parseUrl } from './parse-url.js';
import { render as defaultRender, modes } from './modes.js';
import { NotFoundError, NetworkError } from './fetch.js';
import { VERSION } from './version.js';
import { ICONS, EXTENSION_SH } from './icons.js';
import { LANDING_HTML } from './landing.js';
import {
  fetchPage, htmlToMarkdown, extractTitle, looksJsOnly, visibleText, wrapPage,
  validateTarget, normalizeTargetUrl, canonicalizePageUrl, capMarkdown,
  stripHiddenElements, tryNativeMarkdown, UnsupportedTypeError,
} from './page.js';

const decodedIcons = new Map();

function iconResponse(path) {
  const spec = ICONS[path];
  let body = decodedIcons.get(path);
  if (!body) {
    const bin = atob(spec.b64);
    body = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) body[i] = bin.charCodeAt(i);
    decodedIcons.set(path, body);
  }
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': spec.type,
      'Cache-Control': 'public, max-age=604800, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

const DEADLINE_MS = 45_000;
const CACHE_MAX_AGE = 300;
const CACHE_CONTROL = `public, max-age=${CACHE_MAX_AGE}`;
const BROWSER_CACHE_CONTROL = 'public, max-age=86400';
const CACHE_VERSION = `v${VERSION.split('.').slice(0, 2).join('.')}`;
const PAGE_CACHE_VERSION = 'v0.3.2';
const BROWSER_DAILY_CAP = 40;
const RENDERED_HTML_CAP = 2_000_000;
const TEXT_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";
const TEXT_SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': TEXT_CSP,
};
// Web Analytics auto-injects a beacon from static.cloudflareinsights.com;
// proxied auto-injection reports to /cdn-cgi/rum ('self') and cloudflareinsights.com.
// https://developers.cloudflare.com/web-analytics/faq/
// https://developers.cloudflare.com/fundamentals/reference/policies-compliances/content-security-policies/
const LANDING_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com";

let defaultLimiter;
let defaultBrowserLimiter;
let browserInflight = 0;
const browserJobs = new Map();

export class BrowserQuotaError extends Error {
  constructor(message = 'Browser rendering daily quota exhausted (Cloudflare free plan); try again tomorrow', retryAfter = secondsUntilUtcMidnight()) {
    super(message);
    this.name = 'BrowserQuotaError';
    this.retryAfter = retryAfter;
  }
}

export class BrowserBusyError extends Error {
  constructor(message = 'Browser rendering is busy (free plan limits new/concurrent browsers); retry in a minute') {
    super(message);
    this.name = 'BrowserBusyError';
  }
}

export class BrowserBudgetError extends Error {
  constructor(message = 'Browser rendering budget exceeded; try again later') {
    super(message);
    this.name = 'BrowserBudgetError';
  }
}

export function secondsUntilUtcMidnight(now = Date.now()) {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now) / 1000));
}

function utcDate(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function budgetCacheRequest(kind, date) {
  return new Request(`https://xmd-cache.internal/browser-${kind}/${date}`, { method: 'GET' });
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
      ...TEXT_SECURITY,
      ...headers,
    },
  });
}

function errorResponse(error) {
  if (error.name === 'BrowserQuotaError' || error instanceof BrowserQuotaError) {
    return reply(503, `${error.message}\n`, {
      'Retry-After': String(error.retryAfter ?? secondsUntilUtcMidnight()),
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
  if (error.name === 'BrowserBudgetError' || error instanceof BrowserBudgetError) {
    return reply(429, `${error.message}\n`, {
      'Retry-After': '60',
      'x-xmd-engine': 'browser',
      'x-xmd-browser-error': 'budget',
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
  const canonical = canonicalizePageUrl(href);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
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

async function markBrowserQuota(deps, now = Date.now()) {
  const cache = deps.cache ?? globalThis.caches?.default ?? null;
  if (!cache) return;
  const key = budgetCacheRequest('quota', utcDate(now));
  await cache.put(key, new Response('1', { headers: { 'Cache-Control': 'max-age=172800' } }));
}

// Browser Rendering free plan: 10 browser-minutes/day, 3 concurrent, 1 new browser per 20 s;
// 429 "Browser time limit exceeded for today" until next UTC day.
// https://developers.cloudflare.com/browser-rendering/limits/
// https://developers.cloudflare.com/browser-rendering/pricing/
// Rate Limiting bindings are approximate and per Cloudflare location.
// https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
// Cache API is per data center and not replicated; a strict daily cap needs a Durable Object.
// https://developers.cloudflare.com/workers/runtime-apis/cache/
export async function browserBudget(ip, env, deps = {}) {
  const now = (deps.now ?? Date.now)();
  const date = utcDate(now);
  const cache = deps.cache ?? globalThis.caches?.default ?? null;
  const keyIp = ip || 'unknown';

  if (cache) {
    const flagged = await cache.match(budgetCacheRequest('quota', date));
    if (flagged) return { ok: false, reason: 'quota', retryAfter: secondsUntilUtcMidnight(now) };

    const budgetKey = budgetCacheRequest('budget', date);
    const hit = await cache.match(budgetKey);
    let count = 0;
    if (hit) count = Number.parseInt(await hit.text(), 10) || 0;
    if (count >= BROWSER_DAILY_CAP) return { ok: false, reason: 'quota', retryAfter: secondsUntilUtcMidnight(now) };

    const memoryLimiter = deps.browserLimiter ?? (defaultBrowserLimiter ??= createMemoryLimiter({ limit: 3, now: deps.now ?? Date.now }));
    const memoryAllowed = await memoryLimiter.limit({ key: keyIp });
    if (!memoryAllowed?.success) return { ok: false, reason: 'budget' };

    if (typeof env?.BROWSER_LIMITER?.limit === 'function') {
      const allowed = await env.BROWSER_LIMITER.limit({ key: keyIp });
      if (!allowed?.success) return { ok: false, reason: 'budget' };
    }
    if (typeof env?.BROWSER_GLOBAL_LIMITER?.limit === 'function') {
      const allowed = await env.BROWSER_GLOBAL_LIMITER.limit({ key: 'global' });
      if (!allowed?.success) return { ok: false, reason: 'budget' };
    }

    // Non-atomic increment; per data center only.
    await cache.put(budgetKey, new Response(String(count + 1), { headers: { 'Cache-Control': 'max-age=172800' } }));
    return { ok: true };
  }

  const memoryLimiter = deps.browserLimiter ?? (defaultBrowserLimiter ??= createMemoryLimiter({ limit: 3, now: deps.now ?? Date.now }));
  const memoryAllowed = await memoryLimiter.limit({ key: keyIp });
  if (!memoryAllowed?.success) return { ok: false, reason: 'budget' };

  if (typeof env?.BROWSER_LIMITER?.limit === 'function') {
    const allowed = await env.BROWSER_LIMITER.limit({ key: keyIp });
    if (!allowed?.success) return { ok: false, reason: 'budget' };
  }
  if (typeof env?.BROWSER_GLOBAL_LIMITER?.limit === 'function') {
    const allowed = await env.BROWSER_GLOBAL_LIMITER.limit({ key: 'global' });
    if (!allowed?.success) return { ok: false, reason: 'budget' };
  }
  return { ok: true };
}

async function tryAiMarkdown(env, html, finalUrl) {
  if (typeof env?.AI?.toMarkdown !== 'function') return null;
  try {
    const cleaned = stripHiddenElements(html);
    const result = await env.AI.toMarkdown(
      [{ name: 'page.html', blob: new Blob([cleaned], { type: 'text/html' }) }],
      { conversionOptions: { html: { hostname: finalUrl } } },
    );
    const first = Array.isArray(result) ? result[0] : result;
    if (first?.format === 'markdown' && String(first.data || '').trim()) return capMarkdown(String(first.data));
    return null;
  } catch {
    return null;
  }
}

function budgetFallback(title, finalUrl, markdown, engine) {
  if (!visibleText(markdown)) throw new BrowserBudgetError();
  return { body: wrapPage(title, finalUrl, markdown), engine, browserError: 'budget' };
}

export async function convertWebPage(input, env, deps, { signal, selfHost, ip = 'unknown', cacheKey: jobKey } = {}) {
  const fetchOpts = {
    signal,
    fetchImpl: deps.fetchImpl,
    resolveHost: deps.resolveHost,
    selfHost,
  };
  const page = await fetchPage(input, fetchOpts);
  if (page.media === 'text/plain') {
    return { body: wrapPage(page.title, page.finalUrl, page.body), engine: 'fallback' };
  }
  const native = await tryNativeMarkdown(page, fetchOpts);
  if (native != null) return { body: native, engine: 'native' };
  let markdown = await tryAiMarkdown(env, page.body, page.finalUrl);
  let engine = markdown ? 'ai' : 'fallback';
  if (!markdown) markdown = htmlToMarkdown(page.body, page.finalUrl);
  let title = page.title;
  const canBrowse = typeof deps.browserRender === 'function' && env?.BROWSER;
  if (canBrowse && looksJsOnly(page.body, markdown)) {
    const key = jobKey || page.finalUrl;
    try {
      let renderedHtml;
      const shared = browserJobs.get(key);
      if (shared) {
        renderedHtml = String(await shared ?? '');
      } else {
        const budget = await browserBudget(ip, env, deps);
        const raced = browserJobs.get(key);
        if (raced) {
          renderedHtml = String(await raced ?? '');
        } else if (!budget.ok) {
          if (budget.reason === 'quota') throw new BrowserQuotaError(undefined, budget.retryAfter);
          return budgetFallback(title, page.finalUrl, markdown, engine);
        } else if (browserInflight >= 1) {
          return budgetFallback(title, page.finalUrl, markdown, engine);
        } else {
          browserInflight += 1;
          const job = Promise.resolve().then(() => deps.browserRender(page.finalUrl, {
            signal,
            validate: url => validateTarget(url, { selfHost, resolveHost: deps.resolveHost }),
          })).finally(() => {
            browserInflight -= 1;
            browserJobs.delete(key);
          });
          browserJobs.set(key, job);
          renderedHtml = String(await job ?? '');
        }
      }
      if (renderedHtml.length > RENDERED_HTML_CAP) throw new NetworkError('Rendered page too large');
      let renderedMd = await tryAiMarkdown(env, renderedHtml, page.finalUrl);
      if (!renderedMd) renderedMd = htmlToMarkdown(renderedHtml, page.finalUrl);
      if (visibleText(renderedMd).length > visibleText(markdown).length) {
        markdown = renderedMd;
        title = extractTitle(renderedHtml, title) || title;
        engine = 'browser';
      }
    } catch (error) {
      if (error instanceof BrowserBudgetError || error.name === 'BrowserBudgetError') {
        return budgetFallback(title, page.finalUrl, markdown, engine);
      }
      if (error instanceof BrowserQuotaError || error.name === 'BrowserQuotaError') throw error;
      console.error('xmd browser error', error?.name, String(error?.message || error).slice(0, 500));
      const msg = String(error?.message || error);
      if (/daily|time limit|quota|browser time/i.test(msg)) {
        await markBrowserQuota(deps);
        throw new BrowserQuotaError();
      }
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

function applyTextSecurity(headers) {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', TEXT_CSP);
}

async function serveRendered(request, env, ctx, deps, cache, key, work, defaultEngine) {
  const waitUntil = typeof ctx?.waitUntil === 'function' ? ctx.waitUntil.bind(ctx) : () => {};
  const deadlineMs = deps.deadlineMs ?? DEADLINE_MS;
  const cached = cache ? await cache.match(key) : undefined;
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('x-xmd-cache', 'HIT');
    headers.set('Cache-Control', CACHE_CONTROL);
    applyTextSecurity(headers);
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
      ...TEXT_SECURITY,
      'x-xmd-cache': 'MISS',
      'x-xmd-engine': engine,
      'x-xmd-source': engine,
    };
    if (result && typeof result === 'object' && result.browserError) {
      headers['x-xmd-browser-error'] = result.browserError;
    }
    const response = new Response(body, { status: 200, headers });
    if (cache) {
      const stored = response.clone();
      stored.headers.set('Cache-Control', engine === 'browser' ? BROWSER_CACHE_CONTROL : CACHE_CONTROL);
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
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';

  if (request.method !== 'GET') return reply(405, 'Method not allowed\n', { Allow: 'GET' });

  const url = new URL(request.url);
  const path = url.pathname.replace(/[\x00-\x1f\x7f]/g, '');
  if (path === '/health') return reply(200, 'ok');
  if (path === '/' && url.searchParams.get('url') === null) {
    return new Response(LANDING_HTML, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': LANDING_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Cache-Control': 'public, max-age=300',
      },
    });
  }
  if (path === '/extension.sh') {
    return new Response(EXTENSION_SH, {
      status: 200,
      headers: {
        'Content-Type': 'text/x-shellscript; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=300',
      },
    });
  }
  const iconPath = path === '/favicon-32.png' ? '/favicon.png' : path;
  if (ICONS[iconPath]) return iconResponse(iconPath);

  async function servePost(id, mode) {
    return serveRendered(request, env, ctx, deps, cache, cacheKey(mode, id), signal => renderer(id, mode, undefined, { signal }), 'x');
  }

  if (path === '/') {
    const raw = url.searchParams.get('url');
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
    const key = await pageCacheKey(target.href);
    const selfHost = url.hostname;
    const validateThen = work => async signal => {
      await validateTarget(target.href, { selfHost, resolveHost: deps.resolveHost });
      return work(signal);
    };
    if (typeof deps.renderPage === 'function') {
      return serveRendered(request, env, ctx, deps, cache, key, validateThen(signal => deps.renderPage(target.href, {
        signal,
        resolveHost: deps.resolveHost,
        selfHost,
        fetchImpl: deps.fetchImpl,
      })), 'fallback');
    }
    return serveRendered(request, env, ctx, deps, cache, key, validateThen(signal => convertWebPage(target.href, env, deps, {
      signal,
      selfHost,
      ip,
      cacheKey: key.url,
    })));
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
