import { USER_AGENT } from './version.js';
import { NotFoundError, NetworkError } from './fetch.js';

export class BlockedTargetError extends Error {
  constructor(message = 'Blocked target') { super(message); this.name = 'BlockedTargetError'; }
}
export class UnsupportedTypeError extends Error {
  constructor(message = 'Unsupported content type') { super(message); this.name = 'UnsupportedTypeError'; }
}

export const USAGE = `xmd — turn X posts and web pages into Markdown
GET /?url=<url>              any http(s) page, or an X post
GET /md?url=<url>&mode=      X post (post|thread|ancestors|replies)
GET /md/{mode}?url=<url>
GET /health
`;

const DROP = /<(script|style|noscript|template|svg|iframe|form|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const DROP_EMPTY = /<(script|style|noscript|template|svg|iframe|form|nav|header|footer|aside)\b[^>]*\/?>/gi;
const VOID = new Set(['br', 'img', 'hr', 'meta', 'link', 'input', 'source', 'area', 'col', 'embed', 'wbr']);
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201D', ldquo: '\u201C' };
const V4_CIDR = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16],
  [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24], [0xc0a80000, 16], [0xc6120000, 15],
  [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
];
const SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.ts.net', '.workers.dev'];
const EXACT_HOSTS = new Set(['localhost', 'metadata.google.internal', 'xmd.imfrank.dev']);
const ALLOWED_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown']);
const OUTPUT_CAP = 200 * 1024;
const BODY_CAP = 2 * 1024 * 1024;

export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      try { return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole; } catch { return whole; }
    }
    return NAMED[ent.toLowerCase()] ?? whole;
  });
}

function hostOf(url) {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function ipv4Int(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some(n => n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function ipv4Blocked(n) {
  return V4_CIDR.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (base & mask);
  });
}

function expandIPv6(host) {
  let h = host.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const v4 = h.match(/:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const p = v4[1].split('.').map(Number);
    if (p.some(n => n > 255)) return null;
    h = `${h.slice(0, -v4[1].length)}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  if (!h.includes(':')) return null;
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves.length === 2 ? (halves[1] ? halves[1].split(':').filter(Boolean) : []) : [];
  const fill = 8 - left.length - right.length;
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    return left.map(x => parseInt(x, 16));
  }
  if (fill < 0) return null;
  const parts = [...left, ...Array(fill).fill('0'), ...right].map(x => parseInt(x, 16));
  return parts.every(n => Number.isFinite(n) && n >= 0 && n <= 0xffff) ? parts : null;
}

function ipv6Blocked(parts) {
  const z = n => parts.slice(0, n).every(x => x === 0);
  if (parts.every(x => x === 0)) return true;
  if (z(7) && parts[7] === 1) return true;
  if ((parts[0] & 0xfe00) === 0xfc00) return true;
  if ((parts[0] & 0xffc0) === 0xfe80) return true;
  if ((parts[0] & 0xff00) === 0xff00) return true;
  if (z(5) && parts[5] === 0xffff) return true;
  if (parts[0] === 0x64 && parts[1] === 0xff9b && parts[2] === 0 && parts[3] === 0 && parts[4] === 0 && parts[5] === 0) return true;
  if (parts[0] === 0x2001 && parts[1] === 0xdb8) return true;
  return false;
}

function addressBlocked(addr) {
  const v4 = ipv4Int(addr);
  if (v4 !== null) return ipv4Blocked(v4);
  const v6 = expandIPv6(addr);
  return v6 ? ipv6Blocked(v6) : true;
}

function hostnameBlocked(host, selfHost) {
  if (!host || EXACT_HOSTS.has(host) || SUFFIXES.some(s => host.endsWith(s))) return true;
  if (selfHost && host === String(selfHost).replace(/^\[|\]$/g, '').toLowerCase()) return true;
  if (!host.includes('.') && !host.includes(':')) return true;
  return false;
}

function parseTarget(urlString) {
  let url;
  try { url = new URL(String(urlString).trim()); }
  catch (error) { throw new Error(error.message || 'Invalid URL'); }
  return url;
}

export function isBlockedHostSync(urlString) {
  const raw = String(urlString || '').trim();
  let url;
  try { url = new URL(raw); }
  catch {
    try { url = new URL(`http://${raw}`); }
    catch { return true; }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  if (url.username || url.password) return true;
  if (url.port && url.port !== '80' && url.port !== '443') return true;
  const host = hostOf(url);
  const v4 = ipv4Int(host);
  if (v4 !== null) return ipv4Blocked(v4);
  const v6 = expandIPv6(host);
  if (v6) return ipv6Blocked(v6);
  return hostnameBlocked(host);
}

export async function validateTarget(urlString, { selfHost, resolveHost } = {}) {
  const url = parseTarget(urlString);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedTargetError();
  if (url.username || url.password) throw new BlockedTargetError();
  if (url.port && url.port !== '80' && url.port !== '443') throw new BlockedTargetError();
  const host = hostOf(url);
  const v4 = ipv4Int(host);
  const v6 = v4 === null ? expandIPv6(host) : null;
  if (v4 !== null) {
    if (ipv4Blocked(v4)) throw new BlockedTargetError();
    return url;
  }
  if (v6) {
    if (ipv6Blocked(v6)) throw new BlockedTargetError();
    return url;
  }
  if (hostnameBlocked(host, selfHost)) throw new BlockedTargetError();
  // DoH mitigates but cannot fully prevent DNS rebinding; Workers fetch does not reach private networks anyway.
  const resolver = resolveHost ?? defaultResolveHost;
  const addrs = await resolver(host);
  if (!addrs || addrs.length === 0) throw new NetworkError('Could not resolve host');
  if (addrs.some(addressBlocked)) throw new BlockedTargetError();
  return url;
}

async function defaultResolveHost(hostname) {
  const addrs = [];
  await Promise.all(['A', 'AAAA'].map(async type => {
    try {
      const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return;
      const data = JSON.parse(await response.text());
      for (const ans of data.Answer || []) {
        if (ans.type === 1 || ans.type === 28) addrs.push(ans.data);
      }
    } catch { /* collect whatever answers we got */ }
  }));
  return addrs;
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(raw))) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return attrs;
}

function absolutize(value, baseUrl) {
  if (!value) return '';
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.href;
  } catch { return ''; }
}

export function extractTitle(html, fallback) {
  const og = html.match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["'][^>]*>/i)
    || html.match(/<meta\b[^>]*content=["']([^"']*)["'][^>]*property=["']og:title["'][^>]*>/i);
  if (og?.[1]) return decodeEntities(og[1]).replace(/\s+/g, ' ').trim();
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (title) return decodeEntities(title[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  return fallback || '';
}

function pickMain(html) {
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (article) return article[1];
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main) return main[1];
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (body) return body[1];
  return html;
}

function stripDropped(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(DROP, '').replace(DROP_EMPTY, '');
}

function convertFragment(html, baseUrl) {
  const stack = [];
  let out = '';
  const inPre = () => stack.some(f => f.tag === 'pre');
  function emit(s) {
    if (!s) return;
    if (stack.length) stack[stack.length - 1].buf += s;
    else out += s;
  }
  function closeTag(tag) {
    let idx = -1;
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === tag) { idx = i; break; }
    if (idx < 0) return;
    while (stack.length - 1 > idx) {
      const extra = stack.pop();
      emit(extra.buf);
    }
    const frame = stack.pop();
    const inner = frame.buf;
    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        emit(`\n\n${'#'.repeat(Number(tag[1]))} ${inner.trim()}\n\n`);
        break;
      case 'p': case 'div': case 'section':
        emit(`\n\n${inner.trim()}\n\n`);
        break;
      case 'blockquote':
        emit(`\n\n${inner.trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n`);
        break;
      case 'pre':
        emit(`\n\n\`\`\`\n${inner.replace(/^\n+|\n+$/g, '')}\n\`\`\`\n\n`);
        break;
      case 'code':
        emit(stack.some(f => f.tag === 'pre') ? inner : `\`${inner}\``);
        break;
      case 'strong': case 'b':
        emit(`**${inner}**`);
        break;
      case 'em': case 'i':
        emit(`_${inner}_`);
        break;
      case 'a': {
        const href = frame.attrs.href || '';
        if (/^\s*javascript:/i.test(href)) emit(inner);
        else {
          const abs = absolutize(href, baseUrl);
          emit(abs ? `[${inner.trim()}](${abs})` : inner);
        }
        break;
      }
      case 'li': {
        const parent = stack.findLast?.(f => f.tag === 'ul' || f.tag === 'ol') ?? [...stack].reverse().find(f => f.tag === 'ul' || f.tag === 'ol');
        emit(`${parent?.tag === 'ol' ? '1. ' : '- '}${inner.trim()}\n`);
        break;
      }
      case 'ul': case 'ol':
        emit(`\n\n${inner.trim()}\n\n`);
        break;
      case 'td': case 'th': {
        const tr = stack[stack.length - 1];
        if (tr?.tag === 'tr') tr.cells.push(inner.trim());
        else emit(inner);
        break;
      }
      case 'tr': {
        const table = stack[stack.length - 1];
        const row = (frame.cells || []).join(' | ');
        if (table?.tag === 'table') table.rows.push(row);
        else emit(`\n${row}\n`);
        break;
      }
      case 'table':
        emit(`\n\n${(frame.rows || []).join('\n')}\n\n`);
        break;
      default:
        emit(inner);
    }
  }
  const re = /<(\/)?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) {
      emit(inPre() ? decodeEntities(m[4]) : decodeEntities(m[4]).replace(/\s+/g, ' '));
      continue;
    }
    const closing = Boolean(m[1]);
    const tag = m[2].toLowerCase();
    const rawAttrs = m[3] || '';
    const attrs = parseAttrs(rawAttrs);
    const empty = /\/\s*$/.test(rawAttrs) || VOID.has(tag);
    if (closing) { closeTag(tag); continue; }
    if (tag === 'br') { emit('\n'); continue; }
    if (tag === 'hr') { emit('\n\n---\n\n'); continue; }
    if (tag === 'img') {
      const src = absolutize(attrs.src, baseUrl);
      if (src) emit(`![${decodeEntities(attrs.alt || '')}](${src})`);
      continue;
    }
    if (empty) continue;
    const frame = { tag, attrs, buf: '' };
    if (tag === 'tr') frame.cells = [];
    if (tag === 'table') frame.rows = [];
    stack.push(frame);
  }
  while (stack.length) {
    const frame = stack.pop();
    emit(frame.buf);
  }
  return out;
}

export function htmlToMarkdown(html, baseUrl) {
  const source = String(html ?? '');
  const fragment = pickMain(stripDropped(source));
  let md = convertFragment(fragment, baseUrl)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (md.length > OUTPUT_CAP) md = `${md.slice(0, OUTPUT_CAP).replace(/\s+$/, '')}\n\n_(truncated)_`;
  return md;
}

function combinedSignal(signal) {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readBody(response, decoder) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > BODY_CAP) throw new NetworkError('Upstream body exceeds 2 MB');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { try { await reader.cancel(); } catch {} }
  return text;
}

function decoderFor(contentType) {
  const charset = /charset=([^\s;]+)/i.exec(contentType)?.[1]?.replace(/["']/g, '').trim();
  if (charset) {
    try { return new TextDecoder(charset); } catch { /* fall through */ }
  }
  return new TextDecoder('utf-8');
}

export function wrapPage(title, finalUrl, body) {
  return `# ${title}\n\nSource: ${finalUrl}\n\n${String(body ?? '').trim()}\n`;
}

export function visibleText(markdown) {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[#>*_~\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function htmlBodyText(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

const JS_NOTICE = /enable\s+javascript|requires\s+javascript|javascript\s+is\s+required|you need to enable javascript/i;
const SPA_MOUNT = /<([a-z][\w-]*)\b[^>]*\bid\s*=\s*(?:(?:root|app|__next|__nuxt|svelte)(?=[\s>/])|"(?:root|app|__next|__nuxt|svelte)"|'(?:root|app|__next|__nuxt|svelte)')[^>]*>\s*<\/\1\s*>/i;

export function looksJsOnly(html, markdown) {
  const source = String(html ?? '');
  if (/<noscript\b[\s\S]*javascript[\s\S]*<\/noscript>/i.test(source)) return true;
  if (JS_NOTICE.test(htmlBodyText(source))) return true;
  if (visibleText(markdown).length >= 200) return false;
  const scripts = source.match(/<script\b/gi);
  if (!scripts || scripts.length === 0) return false;
  if (SPA_MOUNT.test(source)) return true;
  if (scripts.length >= 3) return true;
  if (htmlBodyText(source).length < 50) return true;
  return false;
}

export async function fetchPage(input, { signal, fetchImpl = fetch, resolveHost, selfHost } = {}) {
  let current = parseTarget(input);
  const opts = { selfHost, resolveHost };
  await validateTarget(current.href, opts);
  let redirects = 0;
  while (true) {
    const response = await fetchImpl(current.href, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1' },
      signal: combinedSignal(signal),
    });
    if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
      redirects += 1;
      if (redirects > 5) {
        try { await response.body?.cancel(); } catch {}
        throw new NetworkError('Too many redirects');
      }
      const loc = response.headers.get('Location');
      try { await response.body?.cancel(); } catch {}
      if (!loc) throw new NetworkError('Upstream redirect refused');
      current = new URL(loc, current);
      await validateTarget(current.href, opts);
      continue;
    }
    if (response.status === 404 || response.status === 410) throw new NotFoundError(`Page ${current.href} not found`);
    if (!response.ok) throw new NetworkError(`Upstream HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    const media = contentType.split(';')[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.has(media)) throw new UnsupportedTypeError();
    const text = await readBody(response, decoderFor(contentType));
    const host = hostOf(current);
    const html = media === 'text/html' || media === 'application/xhtml+xml';
    const title = html ? (extractTitle(text, host) || host) : host;
    return { finalUrl: current.href, contentType, body: text, title, media };
  }
}

export async function renderPage(input, opts) {
  const page = await fetchPage(input, opts);
  if (page.media === 'text/plain' || page.media === 'text/markdown') return wrapPage(page.title, page.finalUrl, page.body);
  return wrapPage(page.title, page.finalUrl, htmlToMarkdown(page.body, page.finalUrl));
}
