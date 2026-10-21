import { validId } from './parse-url.js';
import { USER_AGENT } from './version.js';
export class NotFoundError extends Error {}
export class NetworkError extends Error {}
const DEFAULT_API_BASE = 'https://api.fxtwitter.com';
let apiBaseOverride;
export function setApiBase(url) {
  apiBaseOverride = url == null || url === '' ? undefined : String(url);
}
function resolveApiBase(options) {
  const raw = options?.apiBase ?? apiBaseOverride ?? globalThis.process?.env?.XMD_API_BASE ?? DEFAULT_API_BASE;
  return String(raw).replace(/\/$/, '');
}
async function request(kind, id, signal, options) {
  if (!validId(id)) throw new NotFoundError('Invalid post id');
  try {
    const base = resolveApiBase(options);
    const response = await fetch(`${base}/2/${kind}/${encodeURIComponent(id)}`, { headers: { 'User-Agent': USER_AGENT }, redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
    if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
      try { await response.body?.cancel(); } catch {}
      throw new NetworkError('Upstream redirect refused');
    }
    if ([400, 404].includes(response.status)) throw new NotFoundError(`Post ${id} not found`);
    if (!response.ok) throw new NetworkError(`Upstream HTTP ${response.status}`);
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 2 * 1024 * 1024) throw new NetworkError('Upstream body exceeds 2 MB');
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel(); }
    const data = JSON.parse(text);
    if ([400, 404].includes(data.code)) throw new NotFoundError(`Post ${id} not found`);
    if (data.code !== 200) throw new NetworkError(`Upstream code ${data.code ?? 'missing'}`);
    if (kind === 'status' && (!data.status || typeof data.status !== 'object')) throw new NetworkError('Missing upstream status');
    if (kind !== 'status' && !Array.isArray(data.thread)) throw new NetworkError('Missing upstream thread');
    return kind === 'status' ? data.status : data;
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof NetworkError) throw error;
    throw new NetworkError(`Upstream request failed: ${error.message}`, { cause: error });
  }
}
export const fetchStatus = (id, signal, options) => request('status', id, signal, options);
export const fetchThread = (id, signal, options) => request('thread', id, signal, options);
export const fetchConversation = (id, signal, options) => request('conversation', id, signal, options);
