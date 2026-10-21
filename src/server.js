import http from 'node:http';
import { isIP } from 'node:net';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseUrl } from './parse-url.js';
import { render, modes } from './modes.js';
import { NotFoundError, NetworkError } from './fetch.js';
import { renderPage as defaultRenderPage, USAGE, UnsupportedTypeError } from './page.js';
export function normalizeHost(value) {
  const host = value.trim().replace(/^\[(.*)\]$/, '$1');
  if (!isIP(host)) throw new Error('Host must be an explicit IP address');
  const normalized = isIP(host) === 6 ? new URL(`http://[${host}]/`).hostname.slice(1, -1) : host;
  if (['0.0.0.0', '::', '::ffff:0:0'].includes(normalized)) throw new Error('Refusing wildcard host');
  return normalized;
}
export function createServer(renderer = render, { deadlineMs = 45_000, renderPage: pageRenderer = defaultRenderPage, resolveHost } = {}) {
  const cache = new Map();
  const inflight = new Map();
  function getWork(key, work) {
    if (!inflight.has(key)) {
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
      const pending = Promise.race([Promise.resolve().then(() => work(controller.signal)), timeout])
        .then(body => {
          while (cache.size >= 200) cache.delete(cache.keys().next().value);
          const entry = { body, expires: Date.now() + 300_000 };
          cache.set(key, entry);
          return entry;
        }).finally(() => { clearTimeout(timer); inflight.delete(key); });
      inflight.set(key, pending);
    }
    return inflight.get(key);
  }
  return http.createServer(async (req, res) => {
    const start = Date.now();
    let path = '/';
    res.on('finish', () => console.log(`${new Date().toISOString()} ${req.method} ${path} ${res.statusCode} ${Date.now()-start}ms`));
    function send(code, body, type = 'text/plain; charset=utf-8') { if (res.headersSent || res.destroyed) return; res.writeHead(code, { 'Content-Type': type }); res.end(body); }
    try {
      const url = new URL(req.url, 'http://localhost');
      path = url.pathname.replace(/[\x00-\x1f\x7f]/g, '');
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(405, 'Method not allowed\n'); }
      if (path === '/health') return send(200, 'ok');
      const selfHost = String(req.headers.host || '').split(':')[0];
      if (path === '/') {
        const raw = url.searchParams.get('url');
        if (raw === null) return send(200, USAGE);
        if (!String(raw).trim()) return send(400, 'Expected a URL\n');
        let post;
        try { post = parseUrl(raw); } catch { post = null; }
        if (post) {
          const mode = url.searchParams.get('mode') || 'post';
          if (!modes.includes(mode)) return send(400, 'Invalid mode\n');
          path += `?mode=${mode}`;
          const key = `${mode}:${post.id}`;
          let entry = cache.get(key);
          if (!entry || entry.expires <= Date.now()) {
            cache.delete(key);
            entry = await getWork(key, signal => renderer(post.id, mode, undefined, { signal }));
          }
          return send(200, entry.body, 'text/markdown; charset=utf-8');
        }
        const href = new URL(String(raw).trim()).href;
        const key = `page:${href}`;
        let entry = cache.get(key);
        if (!entry || entry.expires <= Date.now()) {
          cache.delete(key);
          entry = await getWork(key, signal => pageRenderer(href, { signal, resolveHost, selfHost }));
        }
        return send(200, entry.body, 'text/markdown; charset=utf-8');
      }
      if (path !== '/md' && !/^\/md\/[^/]+$/.test(path)) return send(404, 'Not found\n');
      const mode = path === '/md' ? url.searchParams.get('mode') || 'post' : path.slice(4);
      if (!modes.includes(mode)) return send(400, 'Invalid mode\n');
      path += `?mode=${mode}`;
      const input = url.searchParams.get('url');
      const { id } = parseUrl(input);
      const key = `${mode}:${id}`;
      let entry = cache.get(key);
      if (!entry || entry.expires <= Date.now()) {
        cache.delete(key);
        entry = await getWork(key, signal => renderer(id, mode, undefined, { signal }));
      }
      send(200, entry.body, 'text/markdown; charset=utf-8');
    } catch (error) { send(error.name === 'TimeoutError' ? 504 : error instanceof UnsupportedTypeError ? 415 : error instanceof NotFoundError ? 404 : error instanceof NetworkError ? 502 : 400, `${error.message}\n`); }
  });
}
export function startServer() {
  let host;
  try { host = normalizeHost(process.env.XMD_HOST || '127.0.0.1'); }
  catch (error) { console.error(error.message); process.exit(1); }
  const port = Number(process.env.XMD_PORT || 8792);
  if (['0.0.0.0', '::', '[::]'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) { console.error('Refusing wildcard host or invalid port'); process.exitCode = 1; return; }
  const server = createServer();
  server.on('listening', () => console.log(`listening on ${host}:${port}`));
  let retries = 0;
  server.on('error', error => {
    if (error.code === 'EADDRNOTAVAIL' && retries++ < 30) { console.error('Listen address unavailable; retrying in 10s'); setTimeout(() => server.listen(port, host), 10_000); }
    else { console.error(error.message); process.exit(1); }
  });
  server.listen(port, host);
  return server;
}
let isMain = false;
try {
  isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  // An imported module may have no resolvable process entry point.
}
if (isMain) startServer();
